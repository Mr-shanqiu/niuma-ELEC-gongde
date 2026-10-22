import { Tag } from "antd";

export type Tone = "ok" | "warn" | "bad" | "mute" | "accent";

const styles: Record<Tone, { color: string; background: string; border: string }> = {
  ok: { color: "#2f4a2b", background: "#eef3e8", border: "#d5e0ca" },
  warn: { color: "#7c540d", background: "#fdf6e7", border: "#e8d7b0" },
  bad: { color: "#8a2b15", background: "#fdf0eb", border: "#eec4b7" },
  mute: { color: "#5c6a5f", background: "#f4f6f1", border: "#e2e7db" },
  accent: { color: "#a03a1a", background: "#fdf2ec", border: "#f0cdbe" }
};

/**
 * Status is always a pill with a dot, never a solid block, so states of
 * different severity can still be compared side by side.
 */
export function StatusTag({ tone, dot = false, children }: { tone: Tone; dot?: boolean; children: React.ReactNode }) {
  const style = styles[tone];
  return (
    <Tag
      className={`status-tag${dot ? " has-dot" : ""}`}
      style={{ color: style.color, background: style.background, borderColor: style.border }}
    >
      {dot ? <i className="status-dot" style={{ background: style.color }} aria-hidden="true" /> : null}
      {children}
    </Tag>
  );
}
