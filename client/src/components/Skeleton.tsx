// Lightweight shimmer placeholders — shown while first-load data is in flight so
// pages never flash an empty-state before their data arrives.

export function Skeleton({ w = '100%', h = 11, r = 6, style }: {
  w?: string | number; h?: string | number; r?: number; style?: React.CSSProperties;
}) {
  return <span className="skeleton" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />;
}

function ChipSkeleton() {
  return (
    <div className="contact-chip">
      <Skeleton w={32} h={32} r={9} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <Skeleton w="52%" h={10} style={{ marginBottom: 6 }} />
        <Skeleton w="72%" h={9} />
      </div>
    </div>
  );
}

/** Skeleton table rows. First column renders a contact chip; the rest are bars.
 *  `chipFirst=false` for tables whose first column is a checkbox. */
export function SkeletonRows({ rows = 8, cols, chipCol = 0 }: { rows?: number; cols: number; chipCol?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="skeleton-tr">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}>
              {c === chipCol
                ? <ChipSkeleton />
                : c === cols - 1
                  ? <Skeleton w={28} h={28} r={8} />
                  : <Skeleton w={`${55 + ((r + c) % 3) * 12}%`} h={10} />}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Skeleton block for card-based lists (templates, settings). */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="tpl-card" style={{ pointerEvents: 'none' }}>
      <div className="tpl-card-head">
        <Skeleton w={150} h={13} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Skeleton w={28} h={26} r={7} /><Skeleton w={28} h={26} r={7} />
        </div>
      </div>
      <div className="tpl-card-body">
        <Skeleton w="45%" h={10} style={{ marginBottom: 14 }} />
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} w={`${90 - i * 12}%`} h={9} style={{ marginBottom: 7 }} />
        ))}
      </div>
    </div>
  );
}
