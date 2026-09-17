/** Sync failure text from the API ends with "Reference: stage · kind · status · reason." Show that
 *  part on its own line in the data face so it can be read out or copied to support without the
 *  prose around it. Text without a reference is returned unchanged. */
export function withReference(message: string): React.ReactNode {
	const at = message.lastIndexOf(' Reference: ');
	if (at < 0) return message;
	return <>{message.slice(0, at)}<br /><span className="mono">{message.slice(at + 1)}</span></>;
}
