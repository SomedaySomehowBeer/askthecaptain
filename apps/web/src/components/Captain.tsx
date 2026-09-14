/** The mark, as a CSS mask so it takes the ink colour of wherever it sits. */
export function Captain({ size = 24 }: { size?: number }) {
	return <span className="captain" style={{ width: size, height: size }} aria-hidden="true" />;
}
