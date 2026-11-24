/**
 * Server-side DLP / Sensitive Data Redaction
 * Prevents credit card numbers (Luhn-valid PANs), SSNs, and bearer tokens/API keys
 * from being persisted in plaintext or broadcast across multi-agent threads/events.
 */

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const PAN_CANDIDATE_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const SECRET_TOKEN_RE = /\b(?:rpl_[a-zA-Z0-9_-]{12,}|sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{35})\b/g;

export function redactSensitiveText(input: string): string {
  if (!input) return input;
  let out = input.replace(SECRET_TOKEN_RE, '[REDACTED_SECRET]');
  out = out.replace(SSN_RE, '[REDACTED_SSN]');
  out = out.replace(PAN_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)) {
      return '[REDACTED_CARD]';
    }
    return match;
  });
  return out;
}
