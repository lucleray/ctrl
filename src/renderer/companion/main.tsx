import { createRoot } from "react-dom/client"
import "../styles.css"
import "./companion.css"
import { Companion } from "./Companion"

createRoot(document.getElementById("root")!).render(<Companion />)
