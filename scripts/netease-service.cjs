const SENSITIVE_QUERY = /([?&](?:key|cookie|token|csrf|credential|authorization)=)[^&\s]*/gi;
const SENSITIVE_VALUE = /\b(MUSIC_[A-Z_]+|__csrf)=([^;\s,}\]]+)/gi;
const { inspect } = require('node:util');

function redact(value) {
  const text = typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: 120 });
  return text
    .replace(SENSITIVE_QUERY, "$1[redacted]")
    .replace(SENSITIVE_VALUE, "$1=[redacted]");
}

for (const method of ["debug", "info", "log", "warn", "error"]) {
  const original = console[method].bind(console);
  console[method] = (...values) => original(...values.map(redact));
}

require("@neteasecloudmusicapienhanced/api/app.js");
