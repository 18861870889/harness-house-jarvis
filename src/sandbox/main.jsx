import React from "react";
import { createRoot } from "react-dom/client";
import SandboxApp from "./SandboxApp.jsx";
import "./sandbox.css";

createRoot(document.getElementById("root")).render(<SandboxApp />);
