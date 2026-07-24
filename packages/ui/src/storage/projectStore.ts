import { create } from "zustand";
import {
  listProjects,
  getProject,
  saveProject,
  saveProjectXmlGuarded,
  deleteProject,
  generateId,
  initDatabase,
  type ProjectRecord,
} from "./db";
import { useDesignStore } from "../agent/designStore";

export interface ProjectState {
  projectsList: ProjectRecord[];
  activeProjectId: string | null;
  localLoadedUpdatedAt: number;
  isDowngraded: boolean;
  diskVersion: number;
  initialized: boolean;
  storageError: string | null;
  db: IDBDatabase | null;
  deletedProjectBackup: ProjectRecord | null;
  conflictError: string | null;
  /**
   * Set when an autosave write FAILS (quota exceeded, private-mode storage
   * denied, etc.). Surfaced as a persistent warning banner rather than swallowed
   * — a silent autosave failure is the one way local-first loses work (PRD #26
   * guardrail). Cleared automatically by the next successful save.
   */
  autosaveError: string | null;

  init: () => Promise<void>;
  loadProjects: () => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  createProject: (name: string, templateXml: string) => Promise<string>;
  duplicateProject: (id: string) => Promise<void>;
  renameProject: (id: string, newName: string) => Promise<void>;
  deleteProjectWithUndo: (id: string) => Promise<void>;
  restoreDeletedProject: () => Promise<void>;
  clearDeletedBackup: () => void;
  setConflictError: (err: string | null) => void;
  dismissAutosaveError: () => void;
  saveActiveProjectXml: (xml: string) => Promise<void>;
  setFileHandle: (id: string, fileHandle: FileSystemFileHandle | undefined) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectsList: [],
  activeProjectId: null,
  localLoadedUpdatedAt: 0,
  isDowngraded: false,
  diskVersion: 0,
  initialized: false,
  storageError: null,
  deletedProjectBackup: null,
  conflictError: null,
  autosaveError: null,
  db: null,

  init: async () => {
    const { db, isDowngraded, diskVersion, error } = await initDatabase();
    set({ db, isDowngraded, diskVersion, storageError: error });
    if (!isDowngraded && !error) {
      await get().loadProjects();
    }
    // Publish readiness only after existing projects have loaded. Otherwise a
    // direct /project cold start can observe an empty list and create a phantom
    // "Untitled Project" before IndexedDB returns the user's real projects.
    set({ initialized: true });
  },

  loadProjects: async () => {
    try {
      const projects = await listProjects();
      // Sort projects by updatedAt descending
      projects.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ projectsList: projects });
    } catch (e) {
      console.error("Failed to load projects:", e);
    }
  },

  selectProject: async (id) => {
    try {
      const project = await getProject(id);
      if (project) {
        set({
          activeProjectId: id,
          localLoadedUpdatedAt: project.updatedAt,
          conflictError: null,
        });
        useDesignStore.getState().setUserXml(project.xml);
      }
    } catch (e) {
      console.error(`Failed to select project ${id}:`, e);
    }
  },

  createProject: async (name, templateXml) => {
    const id = generateId();
    const now = Date.now();
    const newProject: ProjectRecord = {
      id,
      name,
      xml: templateXml,
      createdAt: now,
      updatedAt: now,
    };
    await saveProject(newProject);
    await get().loadProjects();
    await get().selectProject(id);
    return id;
  },

  duplicateProject: async (id) => {
    try {
      const orig = await getProject(id);
      if (!orig) return;

      const dupId = generateId();
      const now = Date.now();
      const dupProject: ProjectRecord = {
        ...orig,
        id: dupId,
        name: `${orig.name} (Copy)`,
        createdAt: now,
        updatedAt: now,
        fileHandle: undefined, // Don't share file handle across duplicates
      };
      await saveProject(dupProject);
      await get().loadProjects();
    } catch (e) {
      console.error(`Failed to duplicate project ${id}:`, e);
    }
  },

  renameProject: async (id, newName) => {
    try {
      const project = await getProject(id);
      if (!project) return;

      const now = Date.now();
      const updated = {
        ...project,
        name: newName,
        updatedAt: now,
      };
      await saveProject(updated);
      await get().loadProjects();

      if (id === get().activeProjectId) {
        set({ localLoadedUpdatedAt: now });
      }
    } catch (e) {
      console.error(`Failed to rename project ${id}:`, e);
    }
  },

  deleteProjectWithUndo: async (id) => {
    try {
      const project = await getProject(id);
      if (!project) return;

      set({ deletedProjectBackup: project });
      await deleteProject(id);
      await get().loadProjects();

      if (id === get().activeProjectId) {
        const remaining = get().projectsList;
        if (remaining.length > 0) {
          await get().selectProject(remaining[0].id);
        } else {
          set({ activeProjectId: null, localLoadedUpdatedAt: 0 });
          useDesignStore.getState().setUserXml("");
        }
      }
    } catch (e) {
      console.error(`Failed to delete project ${id}:`, e);
    }
  },

  restoreDeletedProject: async () => {
    const backup = get().deletedProjectBackup;
    if (!backup) return;

    try {
      await saveProject(backup);
      set({ deletedProjectBackup: null });
      await get().loadProjects();
      await get().selectProject(backup.id);
    } catch (e) {
      console.error("Failed to restore deleted project:", e);
    }
  },

  clearDeletedBackup: () => {
    set({ deletedProjectBackup: null });
  },

  setFileHandle: async (id, fileHandle) => {
    try {
      const project = await getProject(id);
      if (!project) return;
      const updated = { ...project, fileHandle };
      await saveProject(updated);
      await get().loadProjects();
    } catch (e) {
      console.error("Failed to set file handle:", e);
    }
  },

  setConflictError: (err) => {
    set({ conflictError: err });
  },

  dismissAutosaveError: () => {
    set({ autosaveError: null });
  },

  saveActiveProjectXml: async (xml: string) => {
    const { activeProjectId, localLoadedUpdatedAt } = get();
    if (!activeProjectId) return;

    try {
      // Monotonic write-guard, made ATOMIC: the get + staleness check + put run
      // inside a SINGLE readwrite transaction (saveProjectXmlGuarded), so a
      // competing tab cannot commit in the window between our read and our
      // write. A stale writer (our loaded base older than what is now on disk)
      // is refused WITHOUT clobbering the newer record.
      const result = await saveProjectXmlGuarded(activeProjectId, xml, localLoadedUpdatedAt);

      if (result.status === "missing") {
        // The project was deleted out from under us; nothing to persist.
        return;
      }
      if (result.status === "conflict") {
        set({ conflictError: "Conflict detected! This project has been updated in another tab. Reload to see the changes." });
        return;
      }

      // status === "saved": adopt the committed updatedAt as our new base and
      // clear any prior autosave-failure banner.
      set({ localLoadedUpdatedAt: result.updatedAt, autosaveError: null });
      await get().loadProjects();
    } catch (e) {
      // Autosave failures (quota exceeded, private-mode storage denied, a
      // closing connection) must NOT be swallowed — surface a persistent
      // warning banner so the user knows their edits are not being persisted.
      console.error("Failed to autosave project:", e);
      set({
        autosaveError: `Your changes could not be saved locally: ${(e as Error).message}. They are kept in this tab, but may be lost if you close or reload. Free up storage or leave private browsing, then edit again to retry.`,
      });
    }
  },
}));
