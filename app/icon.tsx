import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

// Dynamic favicon — renders the 🌐 globe emoji at the browser's icon size.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 52,
          background: "transparent",
        }}
      >
        🌐
      </div>
    ),
    size,
  );
}
