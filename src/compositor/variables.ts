/** Values a layout's text can include as {event}, {date}, {time} and {code}; filled in per print. */
export interface TextVariables {
  event: string;
  date: string;
  time: string;
  code: string;
}

// Spelled out: Node's en-GB short month for September is "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function textVariables(eventName: string, captureId: string, now: Date = new Date()): TextVariables {
  return {
    event: eventName,
    date: `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    code: captureId.slice(0, 8),
  };
}

export function fillVariables(text: string, vars: TextVariables): string {
  return text.replace(/\{(event|date|time|code)\}/g, (_match, name: keyof TextVariables) => vars[name]);
}
