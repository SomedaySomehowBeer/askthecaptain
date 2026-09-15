'use client';
import { Suspense, useDeferredValue, useState } from 'react';

/** A synchronous thenable models a Flight chunk initialized by a sibling render. */
function resource() {
  let ready = false;
  const listeners: Array<() => void> = [];
  const wait = { then(done: () => void) { if (ready) done(); else listeners.push(done); } };
  return {
    read() { if (!ready) throw wait; },
    resolve() { if (ready) return; ready = true; for (const done of listeners) done(); },
  };
}
type Resource = ReturnType<typeof resource>;
function ReadResult({ revision, result }: { revision: number; result: Resource }) {
  if (revision) result.read();
  return <output data-count={revision}>{revision ? 'Updated result' : 'Initial result'}</output>;
}
function CompleteResult({ revision, result }: { revision: number; result: Resource }) {
  if (revision) result.resolve();
  return <span>Sibling revision {revision}</span>;
}
export function SyncPingProbe() {
  const [result] = useState(resource);
  const [revision, setRevision] = useState(0);
  const deferred = useDeferredValue(revision);
  return <section id="sync-probe">
    <h2>A result becomes ready during rendering</h2>
    <p>The requested and displayed revisions must both reach 1.</p>
    <button type="button" onClick={() => setRevision(1)}>Request revision 1</button>
    <p>Requested revision: {revision}</p>
    <Suspense fallback={<p>Waiting for the result</p>}>
      <ReadResult revision={deferred} result={result}/>
      <CompleteResult revision={deferred} result={result}/>
    </Suspense>
  </section>;
}
