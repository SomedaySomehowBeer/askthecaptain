export const copy={
 createUnknown:'This thread may have been created. Its first message and choices are locked. Retry with the same IDs to confirm.',
 createRefused:'Captain refused this thread. Review your text and choices, then start again with new IDs or discard it.',
 createIdUnavailable:'This thread ID cannot be used. Your text and choices are kept; start again with new IDs or discard it.',
 createNewIds:'Review your text and choices, then send to start a new thread.',
 createDiscard:'Draft discarded. Any thread already created remains available to its participants.',
 creating:'Creating the thread…',created:'Thread confirmed.',
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
