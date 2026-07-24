/**
 * The example gallery grid (issue #28 deliverable 2 & 3).
 *
 * Renders the data-driven manifest (`public/gallery.json`) as two rows —
 * "Working designs" and "Fix me" — of cards. Each card's thumbnail is a REAL
 * air-ts `toSchematicSvg` render of that design's bundled XML (fetched once,
 * reused on click), so every thumbnail reflects its own design and no two are the
 * same. Clicking a card hands the entry + its XML up to `onOpen`, which opens it
 * as a new project. Nothing here needs a backend or a key.
 */

import React from "react";
import { Wrench, Cpu, ImageOff, Loader2 } from "lucide-react";
import {
  loadGallery,
  loadEntryXml,
  thumbnailSvg,
  type GalleryEntry,
} from "./gallery";

interface GalleryGridProps {
  /** Open a design as a new project. `xml` is the already-fetched design XML. */
  onOpen: (entry: GalleryEntry, xml: string) => void | Promise<void>;
}

const GalleryGrid: React.FC<GalleryGridProps> = ({ onOpen }) => {
  const [entries, setEntries] = React.useState<GalleryEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    loadGallery()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="gallery-error" role="alert">
        Could not load the example gallery: {error}
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="gallery-loading" data-testid="gallery-loading">
        <Loader2 size={16} className="animate-spin" /> Loading examples…
      </div>
    );
  }

  const working = entries.filter((e) => e.kind === "working");
  const fixme = entries.filter((e) => e.kind === "fixme");

  return (
    <div className="gallery" data-testid="gallery">
      <GalleryRow
        title="Working designs"
        subtitle="Open one and press Simulate — no account, no key, no backend."
        icon={<Cpu size={16} />}
        entries={working}
        onOpen={onOpen}
      />
      {fixme.length > 0 && (
        <GalleryRow
          title="Fix me"
          subtitle="Broken on purpose. Open one to watch the autonomous repair loop diagnose and patch it."
          icon={<Wrench size={16} />}
          entries={fixme}
          onOpen={onOpen}
          fixme
        />
      )}
    </div>
  );
};

function GalleryRow({
  title,
  subtitle,
  icon,
  entries,
  onOpen,
  fixme,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  entries: GalleryEntry[];
  onOpen: GalleryGridProps["onOpen"];
  fixme?: boolean;
}) {
  return (
    <section className="gallery-row" data-testid={fixme ? "gallery-row-fixme" : "gallery-row-working"}>
      <div className="gallery-row-header">
        {icon}
        <h3>{title}</h3>
        <span className="gallery-row-sub">{subtitle}</span>
      </div>
      <div className="gallery-cards">
        {entries.map((entry) => (
          <GalleryCard key={entry.id} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function GalleryCard({
  entry,
  onOpen,
}: {
  entry: GalleryEntry;
  onOpen: GalleryGridProps["onOpen"];
}) {
  // The design XML backs BOTH the thumbnail render and the open-on-click action,
  // so it is fetched once and cached here.
  const [xml, setXml] = React.useState<string | null>(null);
  const [svg, setSvg] = React.useState<string | null>(null);
  const [thumbError, setThumbError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    loadEntryXml(entry)
      .then((text) => {
        if (cancelled) return;
        setXml(text);
        // REAL render — air-ts turns this design's own XML into its schematic SVG.
        setSvg(thumbnailSvg(text));
      })
      .catch(() => {
        if (!cancelled) setThumbError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const handleOpen = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Reuse the XML fetched for the thumbnail; refetch only if it failed.
      const design = xml ?? (await loadEntryXml(entry));
      await onOpen(entry, design);
    } catch {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="gallery-card"
      onClick={handleOpen}
      disabled={busy}
      data-testid={`gallery-card-${entry.id}`}
      data-kind={entry.kind}
      aria-label={`Open ${entry.title}`}
    >
      <div className="gallery-thumb" data-testid={`gallery-thumb-${entry.id}`}>
        {svg ? (
          <div className="gallery-thumb-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : thumbError ? (
          <div className="gallery-thumb-fallback">
            <ImageOff size={18} />
            <span>Preview unavailable</span>
          </div>
        ) : (
          <div className="gallery-thumb-loading">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-title-row">
          <span className="gallery-card-title">{entry.title}</span>
          <span className={`gallery-diff ${entry.difficulty}`}>{entry.difficulty}</span>
        </div>
        <p className="gallery-card-desc">{entry.description}</p>
        <div className="gallery-card-tags">
          {entry.firmware && <span className="gallery-tag firmware">firmware</span>}
          {entry.tags.slice(0, 3).map((t) => (
            <span key={t} className="gallery-tag">
              {t}
            </span>
          ))}
        </div>
      </div>
      {busy && (
        <div className="gallery-card-busy" aria-hidden="true">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
    </button>
  );
}

export default GalleryGrid;
