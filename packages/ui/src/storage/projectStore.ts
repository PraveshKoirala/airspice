import { create } from "zustand";
import {
  listProjects,
  getProject,
  saveProject,
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

  saveActiveProjectXml: async (xml: string) => {
    const { activeProjectId, localLoadedUpdatedAt } = get();
    if (!activeProjectId) return;

    try {
      const project = await getProject(activeProjectId);
      if (!project) return;

      // Monotonic write-guard: check if updatedAt is newer on disk
      if (project.updatedAt > localLoadedUpdatedAt) {
        set({ conflictError: "Conflict detected! This project has been updated in another tab. Reload to see the changes." });
        return;
      }

      const now = Date.now();
      const updated: ProjectRecord = {
        ...project,
        xml,
        updatedAt: now,
      };

      await saveProject(updated);
      set({ localLoadedUpdatedAt: now });
      await get().loadProjects();
    } catch (e) {
      console.error("Failed to autosave project:", e);
    }
  },
}));
