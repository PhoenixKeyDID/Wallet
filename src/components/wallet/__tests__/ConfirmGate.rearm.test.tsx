// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { useLayoutEffect, useState } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ConfirmGate, tailChallenge } from "../ConfirmGate";

afterEach(cleanup);

const POOL = "pool1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz";
const OTHER_POOL = POOL.slice(0, -4) + "yyyy";

/**
 * Acts on the gate from its own layout effect. It sits after the gate, so it
 * runs inside the same commit, after the gate's layout effects and before any
 * passive effect — the window a fast click (or a loaded test runner) lands in
 * right after a review appears.
 */
function ActRightAfterCommit({ act: run }: { act: () => void }) {
  useLayoutEffect(() => {
    run();
  }, []);
  return null;
}

function Review({
  challenge,
  alwaysChallenge,
  actNow,
}: {
  challenge: string;
  alwaysChallenge?: boolean;
  actNow?: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <>
      <ConfirmGate
        network={0}
        challenge={challenge}
        challengeHint="last 4"
        checkboxLabel="I checked"
        confirmed={confirmed}
        onChange={setConfirmed}
        alwaysChallenge={alwaysChallenge}
      />
      {actNow && <ActRightAfterCommit act={actNow} />}
      <button type="button" disabled={!confirmed}>
        Confirm
      </button>
    </>
  );
}

const confirmButton = () => screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;

describe("ConfirmGate: re-arming does not undo what the person just did", () => {
  it("a tick right after the review appears stays ticked", () => {
    render(
      <Review
        challenge={tailChallenge(POOL)}
        actNow={() => fireEvent.click(screen.getByRole("checkbox"))}
      />,
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(confirmButton().disabled).toBe(false);
  });

  it("a tail typed right after the review appears is kept", () => {
    render(
      <Review
        challenge={tailChallenge(POOL)}
        alwaysChallenge
        actNow={() => fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzzz" } })}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("zzzz");
    expect(confirmButton().disabled).toBe(false);
  });

  it("still re-arms when the review switches to another destination", () => {
    const { rerender } = render(<Review challenge={tailChallenge(POOL)} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirmButton().disabled).toBe(false);
    act(() => rerender(<Review challenge={tailChallenge(OTHER_POOL)} />));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
  });
});
