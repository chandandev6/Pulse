import { createContext, type ReactNode, useContext, useState } from "react";
import { useEnvironments } from "./api/releases";

// The dashboard-wide environment choice ("production", "staging", or "" for all).
// Pages read it with useEnvironment(); the sidebar changes it.
type EnvironmentState = {
  environment: string;
  setEnvironment: (name: string) => void;
  names: string[];
};

const EnvironmentContext = createContext<EnvironmentState>({
  environment: "",
  setEnvironment: () => {},
  names: [],
});

const storageKey = (projectId: string) => `pulse:environment:${projectId}`;

function stored(projectId: string): string | null {
  try {
    return localStorage.getItem(storageKey(projectId));
  } catch {
    return null; // storage blocked: just use the default
  }
}

// Remount it per project (key={projectId}) so each project keeps its own choice
export function EnvironmentProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const environments = useEnvironments(projectId);
  const [chosen, setChosen] = useState<string | null>(() => stored(projectId));
  const names = environments.data?.map((env) => env.name) ?? [];

  // Default to production when the project has it; otherwise show everything.
  // A remembered choice that no longer exists falls back the same way.
  const fallback = names.includes("production") || !environments.data ? "production" : "";
  const valid = chosen !== null && (chosen === "" || !environments.data || names.includes(chosen));
  const environment = valid ? chosen : fallback;

  const setEnvironment = (name: string) => {
    setChosen(name);
    try {
      localStorage.setItem(storageKey(projectId), name);
    } catch {
      // ignore
    }
  };

  return (
    <EnvironmentContext.Provider value={{ environment, setEnvironment, names }}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export function useEnvironment() {
  return useContext(EnvironmentContext);
}

export function EnvironmentSelector() {
  const { environment, setEnvironment, names } = useEnvironment();
  // Keep the current choice listed even before the list has loaded
  const options = environment && !names.includes(environment) ? [environment, ...names] : names;

  return (
    <label className="switcher">
      <span className="switcher-label">Environment</span>
      <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
        <option value="">All environments</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
