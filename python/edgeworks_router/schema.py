"""Zero-dependency JSON-schema subset validator (spec §4) + strict-tool schema sanitizer (spec §0/§3).

Strict sanitizer rules come from https://platform.claude.com/docs/en/build-with-claude/structured-outputs
(fetched 2026-09-28), section "JSON Schema limitations":
  Not supported: "Numerical constraints (such as minimum, maximum, multipleOf)", "String constraints
  (minLength, maxLength)", "Array constraints beyond minItems of 0 or 1", "additionalProperties set to
  anything other than false". Supported: "String formats: date-time, time, date, duration, email,
  hostname, uri, ipv4, ipv6, uuid". Regex "NOT supported: Backreferences to groups (for example, \\1, \\2),
  Lookahead/lookbehind assertions (for example, (?=...), (?!...)), Word boundaries: \\b, \\B, Complex {n,m}
  quantifiers with large ranges". "If you use an unsupported feature, you'll receive a 400 error."
The ORIGINAL schema is never mutated; the local json_schema validator keeps every constraint.
"""
from __future__ import annotations

import copy
import re
from typing import Any

# ---------------------------------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------------------------------


def _ptr_escape(token: str) -> str:
    return str(token).replace("~", "~0").replace("/", "~1")


def _is_type(value: Any, t: str) -> bool:
    if t == "null":
        return value is None
    if t == "boolean":
        return isinstance(value, bool)
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "string":
        return isinstance(value, str)
    if t == "integer":
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return True
        return isinstance(value, float) and value.is_integer()  # JSON 1.0 is an integer (matches JS)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return False


def _json_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def validate(instance: Any, schema: Any, pointer: str = "") -> tuple[str, str] | None:
    """Validate `instance`. Returns None if valid, else (json_pointer_of_instance, keyword) of the FIRST
    failure. Keyword check order: type, enum, numeric, string, array (items recursed), object
    (required, properties recursed, additionalProperties)."""
    if not isinstance(schema, dict):
        return None  # true/{} schema
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_is_type(instance, x) for x in types):
            return pointer, "type"
    if "enum" in schema and not any(_json_equal(instance, e) for e in schema["enum"]):
        return pointer, "enum"
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            return pointer, "minimum"
        if "maximum" in schema and instance > schema["maximum"]:
            return pointer, "maximum"
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            return pointer, "minLength"
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            return pointer, "maxLength"
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            return pointer, "pattern"
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            return pointer, "minItems"
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            return pointer, "maxItems"
        items = schema.get("items")
        if isinstance(items, dict):
            for i, v in enumerate(instance):
                r = validate(v, items, f"{pointer}/{i}")
                if r:
                    return r
    if isinstance(instance, dict):
        for req in schema.get("required", []) or []:
            if req not in instance:
                return pointer, "required"
        props = schema.get("properties") or {}
        for k, sub in props.items():
            if k in instance:
                r = validate(instance[k], sub, f"{pointer}/{_ptr_escape(k)}")
                if r:
                    return r
        if schema.get("additionalProperties") is False:
            for k in instance:
                if k not in props:
                    return pointer, "additionalProperties"
    return None


# ---------------------------------------------------------------------------------------------------
# Strict-tool sanitizer
# ---------------------------------------------------------------------------------------------------

SUPPORTED_FORMATS = frozenset({"date-time", "time", "date", "duration", "email", "hostname", "uri",
                               "ipv4", "ipv6", "uuid"})
# Always removed (doc: numerical constraints, string constraints, array constraints beyond minItems 0/1).
# minProperties/maxProperties are not in the doc's supported list -> removed as well.
ALWAYS_STRIP = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                "minLength", "maxLength",
                "maxItems", "uniqueItems", "contains", "minContains", "maxContains",
                "minProperties", "maxProperties")
LARGE_QUANTIFIER = 100  # "{n,m} quantifiers with large ranges": any bound > 100 is treated as large
_BAD_REGEX = re.compile(r"\\[1-9]|\(\?<?[=!]|\\[bB]")
_QUANT = re.compile(r"\{(\d+)(?:,(\d*))?\}")

_SCHEMA_MAP_KEYS = ("properties", "$defs", "definitions", "$def")
_SCHEMA_LIST_KEYS = ("anyOf", "allOf", "oneOf", "prefixItems")
_SCHEMA_ONE_KEYS = ("items", "not", "if", "then", "else")


def _pattern_unsupported(p: str) -> bool:
    if _BAD_REGEX.search(p):
        return True
    for m in _QUANT.finditer(p):
        nums = [int(x) for x in m.groups() if x]
        if any(n > LARGE_QUANTIFIER for n in nums):
            return True
    return False


def _is_object_schema(s: dict[str, Any]) -> bool:
    t = s.get("type")
    return t == "object" or (isinstance(t, list) and "object" in t) or "properties" in s


def sanitize_strict_schema(schema: Any) -> tuple[Any, list[str]]:
    """Deep-copies `schema`, adds additionalProperties:false to every object schema and strips keywords
    unsupported by strict tool use / structured outputs. Returns (sent_schema, stripped) where each
    stripped entry is '<schema-json-pointer>/<keyword>'."""
    out = copy.deepcopy(schema)
    stripped: list[str] = []
    _sanitize(out, "", stripped)
    return out, stripped


def _sanitize(s: Any, path: str, stripped: list[str]) -> None:
    if not isinstance(s, dict):
        return
    for kw in ALWAYS_STRIP:
        if kw in s:
            del s[kw]
            stripped.append(f"{path}/{kw}")
    if "minItems" in s and s["minItems"] not in (0, 1):
        del s["minItems"]
        stripped.append(f"{path}/minItems")
    if "format" in s and s["format"] not in SUPPORTED_FORMATS:
        del s["format"]
        stripped.append(f"{path}/format")
    if isinstance(s.get("pattern"), str) and _pattern_unsupported(s["pattern"]):
        del s["pattern"]
        stripped.append(f"{path}/pattern")
    if _is_object_schema(s):
        if "additionalProperties" in s and s["additionalProperties"] is not False:
            stripped.append(f"{path}/additionalProperties")
        s["additionalProperties"] = False
    for key in _SCHEMA_MAP_KEYS:
        m = s.get(key)
        if isinstance(m, dict):
            for name, sub in m.items():
                _sanitize(sub, f"{path}/{key}/{_ptr_escape(name)}", stripped)
    for key in _SCHEMA_LIST_KEYS:
        lst = s.get(key)
        if isinstance(lst, list):
            for i, sub in enumerate(lst):
                _sanitize(sub, f"{path}/{key}/{i}", stripped)
    for key in _SCHEMA_ONE_KEYS:
        sub = s.get(key)
        if isinstance(sub, dict):
            _sanitize(sub, f"{path}/{key}", stripped)
        elif key == "items" and isinstance(sub, list):
            for i, x in enumerate(sub):
                _sanitize(x, f"{path}/items/{i}", stripped)
