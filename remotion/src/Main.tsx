import { AbsoluteFill, Img, staticFile } from "remotion";

export const Main: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#000",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Img
        src={staticFile("ag0.svg")}
        style={{ width: 466, filter: "brightness(0) invert(1)" }}
      />
    </AbsoluteFill>
  );
};
