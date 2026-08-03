const COLORS: Record<number, string> = {
  30: "#000000",
  31: "#ef4444",
  32: "#22c55e",
  33: "#eab308",
  34: "#3b82f6",
  35: "#a855f7",
  36: "#06b6d4",
  37: "#d1d5db",
  90: "#4b5563",
  91: "#f87171",
  92: "#4ade80",
  93: "#facc15",
  94: "#60a5fa",
  95: "#c084fc",
  96: "#22d3ee",
  97: "#f3f4f6",
};

const BG_COLORS: Record<number, string> = {
  40: "#000000",
  41: "#ef4444",
  42: "#22c55e",
  43: "#eab308",
  44: "#3b82f6",
  45: "#a855f7",
  46: "#06b6d4",
  47: "#d1d5db",
  100: "#4b5563",
  101: "#f87171",
  102: "#4ade80",
  103: "#facc15",
  104: "#60a5fa",
  105: "#c084fc",
  106: "#22d3ee",
  107: "#f3f4f6",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface StyleState {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

function applyCode(style: StyleState, code: number): void {
  if (code === 0) {
    style.color = undefined;
    style.backgroundColor = undefined;
    style.fontWeight = undefined;
    style.fontStyle = undefined;
    style.textDecoration = undefined;
    return;
  }
  if (code === 1) style.fontWeight = "bold";
  if (code === 3) style.fontStyle = "italic";
  if (code === 4) style.textDecoration = "underline";
  if (code === 22) style.fontWeight = undefined;
  if (code === 23) style.fontStyle = undefined;
  if (code === 24) style.textDecoration = undefined;
  if (code === 39) style.color = undefined;
  if (code === 49) style.backgroundColor = undefined;
  if (COLORS[code]) style.color = COLORS[code];
  if (BG_COLORS[code]) style.backgroundColor = BG_COLORS[code];
}

function styleAttribute(style: StyleState): string {
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.backgroundColor) parts.push(`background-color:${style.backgroundColor}`);
  if (style.fontWeight) parts.push(`font-weight:bold`);
  if (style.fontStyle) parts.push(`font-style:italic`);
  if (style.textDecoration) parts.push(`text-decoration:underline`);
  return parts.join(";");
}

export function ansiToHtml(text: string): string {
  const segments: string[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  const style: StyleState = {};

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) {
      if (Object.keys(style).length > 0) {
        segments.push(`<span style="${styleAttribute(style)}">${escapeHtml(before)}</span>`);
      } else {
        segments.push(escapeHtml(before));
      }
    }
    const codes = match[1] === "" ? [0] : match[1].split(";").map((c) => (c === "" ? 0 : Number.parseInt(c, 10)));
    for (const code of codes) {
      applyCode(style, code);
    }
    lastIndex = regex.lastIndex;
  }

  const tail = text.slice(lastIndex);
  if (tail) {
    if (Object.keys(style).length > 0) {
      segments.push(`<span style="${styleAttribute(style)}">${escapeHtml(tail)}</span>`);
    } else {
      segments.push(escapeHtml(tail));
    }
  }

  return segments.join("");
}
