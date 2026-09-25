'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
const Feedback = createContext<((message: string, focus: boolean) => void) | null>(null);
export const useTaskFeedback = () => useContext(Feedback);

/** Remains mounted when a completed row moves groups or leaves the current filter. */
export function TaskListFeedback({ children }: { children: ReactNode }) {
 const [notice, setNotice] = useState({ message: '', focus: false, sequence: 0 });
 const status = useRef<HTMLParagraphElement>(null);
 useEffect(() => { if (notice.focus) status.current?.focus({ preventScroll: true }); }, [notice]);
 return <Feedback.Provider value={(message, focus) => setNotice(previous => ({ message, focus, sequence: previous.sequence + 1 }))}>
  <p ref={status} role="status" aria-label="Work updates" tabIndex={-1} className={notice.message ? 'work-feedback' : 'visually-hidden'}>{notice.message}</p>
  {children}
 </Feedback.Provider>;
}
