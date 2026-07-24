/**
 * First-run tour (issue #28 deliverable 4).
 *
 * A dismissible, hand-rolled 5-step overlay — no tour library, just a fixed
 * backdrop + a stepper card. Each step names a real feature (schematic<->XML
 * sync, Run simulation, Ask the agent, Share) with honest copy: this tool does
 * schematic capture, simulation, and autonomous repair — it does not "design your
 * PCB for you". Closing at any step (Skip, the X, Escape, or Done) marks it seen
 * so it never auto-repeats; Help re-launches it.
 */

import React from "react";
import { X, ArrowRight, ArrowLeft, CircuitBoard, Play, MessageSquare, Share2, Sparkles } from "lucide-react";

interface TourStep {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    icon: <Sparkles size={22} />,
    title: "Welcome to AirSpice",
    body: "AirSpice captures a schematic, simulates it, and can autonomously repair failing designs — all in your browser, no backend. Here is the 30-second tour.",
  },
  {
    icon: <CircuitBoard size={22} />,
    title: "Schematic and XML stay in sync",
    body: "The Schematic and AIR XML tabs are two views of one design. Drag and wire on the canvas, or edit the XML directly — each edit updates the other live.",
  },
  {
    icon: <Play size={22} />,
    title: "Run a simulation",
    body: "Press Simulate in the toolbar to compile and run the design through the in-browser analog engine. Waveforms and assertion results appear in the Simulation tab — no key, no server.",
  },
  {
    icon: <MessageSquare size={22} />,
    title: "Ask the agent",
    body: "Describe a circuit or a change in the chat and the agent proposes an edit that must pass the validation gate before it is applied. This step needs an AI provider key — add yours in Settings (BYOK).",
  },
  {
    icon: <Share2 size={22} />,
    title: "Share a design",
    body: "Share copies a link with the whole design encoded in the URL — no account, no upload. Open a broken example from the gallery to watch the repair loop fix it.",
  },
];

interface OnboardingTourProps {
  onClose: () => void;
}

const OnboardingTour: React.FC<OnboardingTourProps> = ({ onClose }) => {
  const [step, setStep] = React.useState(0);
  const last = STEPS.length - 1;
  const current = STEPS[step]!;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="First-run tour" data-testid="tour-overlay">
      <div className="tour-card">
        <button className="tour-close" onClick={onClose} aria-label="Close tour" data-testid="tour-dismiss">
          <X size={16} />
        </button>

        <div className="tour-icon">{current.icon}</div>
        <span className="tour-step-count">
          Step {step + 1} of {STEPS.length}
        </span>
        <h2 className="tour-title">{current.title}</h2>
        <p className="tour-body">{current.body}</p>

        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={`tour-dot ${i === step ? "active" : ""}`} />
          ))}
        </div>

        <div className="tour-actions">
          <button className="tour-skip" onClick={onClose} data-testid="tour-skip">
            {step === last ? "Close" : "Skip"}
          </button>
          <div className="tour-nav">
            {step > 0 && (
              <button className="tour-back" onClick={() => setStep((s) => s - 1)} data-testid="tour-back">
                <ArrowLeft size={14} /> Back
              </button>
            )}
            {step < last ? (
              <button className="tour-next" onClick={() => setStep((s) => s + 1)} data-testid="tour-next">
                Next <ArrowRight size={14} />
              </button>
            ) : (
              <button className="tour-next" onClick={onClose} data-testid="tour-done">
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingTour;
