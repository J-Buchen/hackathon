/**
 * Renders an allowlist (merchants or purposes). `null` means unrestricted
 * ("any") — the top of the attenuation chain typically allows any merchant and
 * children narrow it down.
 */
export function Allowlist({
  label,
  items,
}: {
  label: string;
  items: string[] | null;
}) {
  return (
    <div className="allowlist">
      <span className="allowlist-label">{label}</span>
      {items === null ? (
        <span className="chip chip-any" title="Unrestricted — inherits from parent scope">
          any
        </span>
      ) : items.length === 0 ? (
        <span className="chip chip-none">none</span>
      ) : (
        <span className="allowlist-items">
          {items.map((it) => (
            <span key={it} className="chip chip-allow">
              {it}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
