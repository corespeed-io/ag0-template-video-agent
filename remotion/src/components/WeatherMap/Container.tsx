import type { ReactNode } from "react";
import React from "react";
import { AbsoluteFill } from "remotion";

import { CANVAS } from "../../Video/components/Canvas";

const { center } = CANVAS;

interface ContainerProps {
  children: ReactNode | ReactNode[];
}

export const Container = ({ children }: ContainerProps) => {
  const [c1, c2] = React.Children.toArray(children);
  return (
    <>
      <AbsoluteFill
        style={{
          width: center.x,
          justifyContent: "center",
          alignItems: "center",
          left: -300,
        }}
      >
        <div
          style={{
            width: 1080,
            height: 1920,
            backgroundColor: "#13001e",
            overflow: "hidden",
          }}
        >
          {c1}
        </div>
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: center.x - 300,
          right: 0,
          top: 0,
          bottom: 0,
          width: center.x,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {c2}
      </div>
    </>
  );
};
