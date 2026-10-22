// Which level an escalation step lands on. Pure, so it's easy to test.
//
// Step 0 is the first notification (level 1). Each timeout without an
// acknowledgement adds one step. With 3 levels and repeatCount 1:
//   step: 0  1  2 | 3  4  5 | 6
//   level 1  2  3 | 1  2  3 | done
export function levelForStep(levelCount: number, repeatCount: number, step: number) {
  if (levelCount === 0 || step < 0) return null;
  const pass = Math.floor(step / levelCount);
  if (pass > repeatCount) return null; // every level and repeat was tried
  return { levelIndex: step % levelCount, pass };
}

// The last step that still notifies someone; the step after it ends the escalation
export const lastStep = (levelCount: number, repeatCount: number) =>
  levelCount * (repeatCount + 1) - 1;
