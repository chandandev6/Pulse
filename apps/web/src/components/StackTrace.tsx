import { useState } from "react";
import type { StackFrame } from "../api/types";

// A frame's position in the stack is its identity (the same function can appear twice)
type KeyedFrame = { key: string; frame: StackFrame };
type Group = { key: string; inApp: boolean; frames: KeyedFrame[] };

// Consecutive library frames are folded into one "N library frames" row,
// so the app's own code (where the bug usually is) stands out.
function groupFrames(frames: StackFrame[]): Group[] {
  const groups: Group[] = [];
  frames.forEach((frame, position) => {
    const keyed = { key: `frame-${position}`, frame };
    const inApp = frame.in_app !== false;
    const last = groups.at(-1);
    if (last && last.inApp === inApp) last.frames.push(keyed);
    else groups.push({ key: `group-${position}`, inApp, frames: [keyed] });
  });
  return groups;
}

const locationOf = (frame: Omit<StackFrame, "in_app" | "minified">) =>
  [frame.filename ?? "<unknown>", frame.lineno, frame.colno]
    .filter((part) => part !== undefined)
    .join(":");

function Frame({ frame }: { frame: StackFrame }) {
  return (
    <li className={`frame ${frame.in_app === false ? "frame-lib" : "frame-app"}`}>
      <span className="frame-fn">{frame.function ?? "<anonymous>"}</span>
      <span className="frame-file">{locationOf(frame)}</span>
      {frame.minified && (
        <span className="frame-minified" title="Translated with an uploaded source map">
          source-mapped from {locationOf(frame.minified)}
        </span>
      )}
    </li>
  );
}

function LibraryGroup({ frames }: { frames: KeyedFrame[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="frame-group">
      <button type="button" className="link-button" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {frames.length} library frame{frames.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ol className="frames">
          {frames.map(({ key, frame }) => (
            <Frame key={key} frame={frame} />
          ))}
        </ol>
      )}
    </li>
  );
}

// Frames are stored oldest first; we show the crash (newest) at the top, like most tools
export function StackTrace({ frames }: { frames: StackFrame[] }) {
  if (frames.length === 0) return <p className="muted">No stack trace was sent.</p>;

  const groups = groupFrames([...frames].reverse());
  return (
    <ol className="frames" aria-label="Stack trace">
      {groups.map((group) =>
        group.inApp ? (
          group.frames.map(({ key, frame }) => <Frame key={key} frame={frame} />)
        ) : (
          <LibraryGroup key={group.key} frames={group.frames} />
        ),
      )}
    </ol>
  );
}
