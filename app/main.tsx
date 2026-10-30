import { createRoot } from "react-dom/client";
import { DesktopApp } from "../desktop/app";
import "./globals.css";
import "./script-ui.css";
import "./workspace-ui.css";
import "../desktop/desktop.css";
document.documentElement.classList.add("desktop-offline");
try { document.documentElement.dataset.theme = localStorage.getItem("lt-theme") === "light" ? "light" : "dark"; } catch { /* Shared default. */ }
createRoot(document.getElementById("root")!).render(<DesktopApp />);
