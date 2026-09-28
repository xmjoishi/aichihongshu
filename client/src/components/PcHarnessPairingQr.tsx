import { useMemo } from "react";
import { toQR } from "toqr";

type PcHarnessPairingQrProps = {
  baseUrl: string;
  pairingToken: string;
  protocolVersion: string;
};

/** Generate the pairing QR entirely on this PC; the token is never sent to a QR service. */
export default function PcHarnessPairingQr({
  baseUrl,
  pairingToken,
  protocolVersion,
}: PcHarnessPairingQrProps) {
  const payload = useMemo(
    () => JSON.stringify({
      type: "aichihongshu-pc-harness",
      version: 1,
      protocolVersion,
      baseUrl,
      pairingToken,
    }),
    [baseUrl, pairingToken, protocolVersion],
  );

  const matrix = useMemo(() => toQR(payload), [payload]);
  const moduleCount = Math.round(Math.sqrt(matrix.length));
  const path = useMemo(() => {
    const commands: string[] = [];
    for (let y = 0; y < moduleCount; y += 1) {
      for (let x = 0; x < moduleCount;) {
        if (!matrix[y * moduleCount + x]) {
          x += 1;
          continue;
        }
        const start = x;
        while (x < moduleCount && matrix[y * moduleCount + x]) x += 1;
        commands.push(`M${start + 4} ${y + 4}h${x - start}v1H${start + 4}z`);
      }
    }
    return commands.join("");
  }, [matrix, moduleCount]);

  const viewSize = moduleCount + 8;

  return (
    <svg
      role="img"
      aria-label={`PC Harness 手机配对二维码，地址 ${baseUrl}`}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      shapeRendering="crispEdges"
      className="h-60 w-60 rounded-lg bg-white p-2"
    >
      <rect width={viewSize} height={viewSize} fill="#fff" />
      <path d={path} fill="#111827" />
    </svg>
  );
}
