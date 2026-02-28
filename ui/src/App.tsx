import ChatPanel from "./ChatPanel";

export default function App() {
  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      {/* Left panel: Chat (40%) */}
      <div
        style={{
          width: "40%",
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid #333",
          background: "#111",
        }}
      >
        <ChatPanel />
      </div>

      {/* Right panel: Remotion Studio (60%) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <iframe
          src="http://localhost:3000"
          style={{
            flex: 1,
            border: "none",
            width: "100%",
            height: "100%",
          }}
          title="Remotion Studio"
          allow="autoplay; fullscreen"
        />
      </div>
    </div>
  );
}
