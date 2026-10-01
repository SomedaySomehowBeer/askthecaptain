export const copy={
 loading:'Loading threads…',empty:'No threads match this filter.',failed:'Could not load threads. Check the connection and try again.',
 unavailable:'Threads are not available in this client yet.',lost:'This thread is no longer available.',wait:'Captain asked you to wait before trying again.',
 threadLoading:'Loading the thread…',threadFailed:'Could not load the thread. Check the connection and try again.',emptyMessages:'No messages yet.',
 unknown:'This message may have been sent. Its text and ID are locked until confirmed. Check for it or retry the same message.',
 refused:'Captain refused this message. Review it, then choose a new send or discard it.',rate:'Too many requests. Your draft is still editable; wait before sending again.',
 storage:'The draft could not be saved in this tab. Nothing was sent. Allow session storage and try again.',
 conflict:'The record changed. Review its current state before choosing again.',mutationUnknown:'Could not confirm that change. Check the current state before choosing again.',
 pending:'Sending…',catching:'Checking newer changes…',gap:'Some messages have not loaded. Refresh before treating this view as complete.',
 privacy:'Private threads are visible only to their participants. No agent processing is available in this version.',
 files:'Files and People are not available yet.',paused:'Updates paused after 10 minutes without activity. Interact or refresh to resume.'
} as const;
