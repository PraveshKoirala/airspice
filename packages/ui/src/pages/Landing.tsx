import React from "react";
import { Plus, FolderOpen, CircuitBoard, Clock, ChevronRight, Compass } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useProjectStore } from "../storage/projectStore";
import { openFromDisk } from "../storage/fileIo";
import GalleryGrid from "../gallery/GalleryGrid";
import type { GalleryEntry } from "../gallery/gallery";
import { setWorkspaceIntent } from "../onboarding/workspaceIntent";

const BLANK_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<system name="blank_design" ir_version="0.1">
  <metadata>
    <title>Blank Design</title>
    <description>A fresh, blank electronic design.</description>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
  </nets>
  <components/>
  <simulation_profiles/>
</system>`;

const Landing: React.FC = () => {
  const navigate = useNavigate();
  const projectsList = useProjectStore((s) => s.projectsList);
  const createProject = useProjectStore((s) => s.createProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const setFileHandle = useProjectStore((s) => s.setFileHandle);

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const handleNewProject = async () => {
    try {
      await createProject("Untitled Project", BLANK_TEMPLATE);
      navigate("/project");
    } catch (e) {
      alert("Failed to create project: " + (e as Error).message);
    }
  };

  const handleOpenProject = async () => {
    try {
      const res = await openFromDisk();
      if (!res) return;

      const pId = await createProject(res.name, res.xml);
      if (res.fileHandle) {
        await setFileHandle(pId, res.fileHandle);
      }
      navigate("/project");
    } catch (e) {
      alert("Failed to open project: " + (e as Error).message);
    }
  };

  const handleSelectRecent = async (id: string) => {
    await selectProject(id);
    navigate("/project");
  };

  // Open a gallery example as a NEW project (instant, backend-off, keyless). A
  // "Fix me" card additionally routes the workspace onto the Repair tab, primed
  // for the autonomous loop over the failing design.
  const handleOpenExample = async (entry: GalleryEntry, xml: string) => {
    try {
      await createProject(entry.title, xml);
      if (entry.kind === "fixme") {
        setWorkspaceIntent({ tab: "repair" });
      }
      navigate("/project");
    } catch (e) {
      alert("Failed to open example: " + (e as Error).message);
    }
  };

  // Re-launch the first-run tour from the front door: arm it and enter the
  // workspace (the auto-migration guarantees a project to show it against).
  const handleTakeTour = () => {
    setWorkspaceIntent({ tour: true });
    navigate("/project");
  };

  const formatRelativeTime = (timestamp: number) => {
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div className="landing-container">
      <div className="landing-hero">
        <CircuitBoard size={64} className="hero-logo" />
        <h1>AirSpice</h1>
        <p>Capture a schematic, simulate it in your browser, and let the agent repair it.</p>
        <button className="hero-tour-btn" onClick={handleTakeTour} data-testid="take-tour">
          <Compass size={15} /> New here? Take the 30-second tour
        </button>
      </div>

      <div className="landing-actions">
        <button className="action-card primary" onClick={handleNewProject} aria-label="New Project">
          <div className="action-icon">
            <Plus size={32} />
          </div>
          <div className="action-text">
            <h3>New Project</h3>
            <p>Start a blank design and tell the AI what to build.</p>
          </div>
        </button>

        <button className="action-card" onClick={handleOpenProject} aria-label="Open Project">
          <div className="action-icon">
            <FolderOpen size={32} />
          </div>
          <div className="action-text">
            <h3>Open Project</h3>
            <p>Browse your local files for .air.xml projects.</p>
          </div>
        </button>
      </div>

      <div className="landing-gallery">
        <div className="section-header">
          <CircuitBoard size={18} />
          <span>Start from an example</span>
        </div>
        <GalleryGrid onOpen={handleOpenExample} />
      </div>

      {projectsList.length > 0 && (
        <div className="recent-projects">
          <div className="section-header">
            <Clock size={18} />
            <span>Recent Projects</span>
          </div>
          <div className="project-list">
            {projectsList.map((project) => (
              <div
                key={project.id}
                className="project-item"
                onClick={() => handleSelectRecent(project.id)}
              >
                <div className="project-info">
                  <span className="project-name">{project.name}</span>
                  <span className="project-path">Stored in this browser</span>
                </div>
                <div className="project-meta">
                  <span>{formatRelativeTime(project.updatedAt)}</span>
                  <ChevronRight size={16} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Landing;
