import { useState } from "react";
import type { ReactElement } from "react";
import App from "./App";
import Admin from "./Admin";
import Home from "./Home";

export default function Root(): ReactElement {
  const [view, setView] = useState<"home" | "chat">("home");
  const [showAdmin, setShowAdmin] = useState(false);

  return (
    <>
      {view === "home" ? (
        <Home onOpenChat={() => setView("chat")} onOpenAdmin={() => setShowAdmin(true)} />
      ) : (
        <App onHome={() => setView("home")} />
      )}
      {showAdmin && <Admin onClose={() => setShowAdmin(false)} />}
    </>
  );
}
