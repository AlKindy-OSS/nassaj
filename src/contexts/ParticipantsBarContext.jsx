import React, { createContext, useContext, useEffect, useState } from 'react';

/**
 * @typedef {Object} ParticipantsBarContextValue
 * @property {boolean} showParticipantsBar
 * @property {(next: boolean) => void} setShowParticipantsBar
 */

/** @type {import('react').Context<ParticipantsBarContextValue | null>} */
const ParticipantsBarContext = createContext(null);

const STORAGE_KEY = 'showParticipantsBar';

/**
 * useParticipantsBar
 *
 * Access the participants bar collapse state, driven solely by the chevron
 * control in the chat interface (there is no settings toggle). This is a pure
 * UI state (does not affect any network/identity behaviour) persisted in
 * localStorage. Defaults to `true` — the bar is always shown unless the user
 * collapsed it via the chevron; while collapsed, the bar — and therefore its
 * hook/polling — does not mount at all.
 *
 * Returns `{ showParticipantsBar: boolean,
 *            setShowParticipantsBar: (next: boolean) => void }`.
 */
export const useParticipantsBar = () => {
  const ctx = useContext(ParticipantsBarContext);
  if (!ctx) {
    throw new Error('useParticipantsBar must be used within a ParticipantsBarProvider');
  }
  return ctx;
};

const readInitial = () => {
  try {
    // Default ON: only an explicit 'false' (chevron-collapsed) hides the bar.
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const ParticipantsBarProvider = ({ children }) => {
  const [showParticipantsBar, setShowParticipantsBar] = useState(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(showParticipantsBar));
    } catch {
      // Storage unavailable (private mode, quota).
    }
  }, [showParticipantsBar]);

  return (
    <ParticipantsBarContext.Provider value={{ showParticipantsBar, setShowParticipantsBar }}>
      {children}
    </ParticipantsBarContext.Provider>
  );
};
