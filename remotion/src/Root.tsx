import { Composition } from "remotion";
import { Main } from "./Main";

const fps = 30;
const durationInFrames = fps * 10;

export const RemotionVideo: React.FC = () => {
  return (
    <>
      <Composition
        id="Main"
        component={Main}
        durationInFrames={durationInFrames}
        fps={fps}
        width={1920}
        height={1080}
      />
    </>
  );
};
