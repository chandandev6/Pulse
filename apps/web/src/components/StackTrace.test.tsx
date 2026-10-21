import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StackTrace } from "./StackTrace";

const frames = [
  { function: "main", filename: "/app/server.js", lineno: 1, in_app: true },
  {
    function: "dispatch",
    filename: "/app/node_modules/express/router.js",
    lineno: 9,
    in_app: false,
  },
  { function: "next", filename: "/app/node_modules/express/layer.js", lineno: 4, in_app: false },
  { function: "checkout", filename: "/app/cart.js", lineno: 42, colno: 7, in_app: true },
];

describe("StackTrace", () => {
  it("shows the crash first and folds library frames", async () => {
    render(<StackTrace frames={frames} />);

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("checkout/app/cart.js:42:7");
    expect(items[0]).toHaveClass("frame-app");
    expect(screen.queryByText("dispatch")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show 2 library frames" }));
    expect(screen.getByText("dispatch")).toBeInTheDocument();
    expect(screen.getByText("next").closest("li")).toHaveClass("frame-lib");
  });

  it("says so when there is no stack", () => {
    render(<StackTrace frames={[]} />);
    expect(screen.getByText("No stack trace was sent.")).toBeInTheDocument();
  });
});
