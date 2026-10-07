import { StyleSheet, View } from 'react-native';

/** Small icons drawn with plain views, so no icon or SVG dependency is needed. Decorative: each is `aria-hidden`,
 *  which React Native maps on iOS, Android and the web; the control's label names it. */

/** A left chevron for a header's way back: `small` beside the prototype's 12 pt crumb, `large` beside the R3 back link. */
export function Chevron({ color, size = 'large' }: { color: string; size?: 'small' | 'large' }) {
	return <View aria-hidden style={[styles.chevron, size === 'small' && styles.chevronSmall, { borderColor: color }]} />;
}

/** A down chevron (a folded card or group: tap to open) or, `up`, an up chevron (open: tap to fold). Prototype frame 1
 *  `.ghead svg`, R3 Main's card chevron. */
export function ChevronDown({ color, up = false, size = 9 }: { color: string; up?: boolean; size?: number }) {
	return <View aria-hidden style={{ width: size * 2, height: size * 2, alignItems: 'center', justifyContent: 'center' }}>
		<View style={{ width: size, height: size, borderRightWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: up ? '-135deg' : '45deg' }], marginTop: up ? size / 2 : -size / 2 }} />
	</View>;
}

/** A plus, for the thread list's "New thread" button (prototype frame 1 `.new svg`). */
export function Plus({ color }: { color: string }) {
	return <View style={styles.icon18} aria-hidden>
		<View style={{ position: 'absolute', left: 8.2, top: 3, width: 1.8, height: 12, borderRadius: 1, backgroundColor: color }} />
		<View style={{ position: 'absolute', left: 3, top: 8.2, width: 12, height: 1.8, borderRadius: 1, backgroundColor: color }} />
	</View>;
}

/** A pencil, for a change line (R3 Lines `.change svg`). */
export function Pencil({ color }: { color: string }) {
	return <View style={styles.icon14} aria-hidden>
		<View style={{ position: 'absolute', left: 5.4, top: -0.6, width: 3.2, height: 12, borderWidth: 1.4, borderColor: color, borderRadius: 0.8, transform: [{ rotate: '45deg' }] }} />
		<View style={{ position: 'absolute', left: 0.6, top: 12.2, width: 3.4, height: 1.4, backgroundColor: color, borderRadius: 1 }} />
	</View>;
}

/** A circle with a tick, for an "everything else stays" note (R3 Preview `.note-ok svg`). */
export function Tick({ color }: { color: string }) {
	return <View style={styles.icon14} aria-hidden>
		<View style={{ position: 'absolute', left: 2.4, top: 2, width: 8.5, height: 5, borderLeftWidth: 1.8, borderBottomWidth: 1.8, borderColor: color, transform: [{ rotate: '-45deg' }] }} />
	</View>;
}

/** A warning triangle's mark, for a warning note (R3 Conflict and Blocked `.note-warn svg`). */
export function Alert({ color }: { color: string }) {
	return <View style={styles.icon14} aria-hidden>
		<View style={{ position: 'absolute', left: 1, top: 0.5, width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: color }} />
		<View style={{ position: 'absolute', left: 6.25, top: 3.2, width: 1.5, height: 4.4, borderRadius: 1, backgroundColor: color }} />
		<View style={{ position: 'absolute', left: 6.25, top: 8.6, width: 1.5, height: 1.6, borderRadius: 1, backgroundColor: color }} />
	</View>;
}

/** A right chevron for a row that opens something. */
export function ChevronRight({ color }: { color: string }) {
	return <View aria-hidden style={[styles.chevronRight, { borderColor: color }]} />;
}

/** A magnifier for the header's search control. */
export function Magnifier({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 2, top: 2, width: 11, height: 11, borderRadius: 6, borderWidth: 1.8, borderColor: color }} />
			<View style={{ position: 'absolute', left: 12, top: 11, width: 1.8, height: 6, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '-45deg' }] }} />
		</View>
	);
}

/** A calendar for the equipment schedule's pinned row. */
export function Calendar({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 1, top: 3, width: 16, height: 14, borderRadius: 3, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 1, top: 7, width: 16, height: 1.6, backgroundColor: color }} />
			<View style={{ position: 'absolute', left: 5, top: 1, width: 1.6, height: 4, backgroundColor: color }} />
			<View style={{ position: 'absolute', left: 11.4, top: 1, width: 1.6, height: 4, backgroundColor: color }} />
		</View>
	);
}

/** Two heads for the team's pinned row. */
export function People({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 3, top: 2, width: 6, height: 6, borderRadius: 3, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 0, top: 9, width: 12, height: 7, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderWidth: 1.6, borderBottomWidth: 0, borderColor: color }} />
			<View style={{ position: 'absolute', left: 11, top: 3, width: 5, height: 5, borderRadius: 2.5, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 12, top: 10, width: 6, height: 6, borderTopLeftRadius: 2, borderTopRightRadius: 6, borderWidth: 1.6, borderBottomWidth: 0, borderLeftWidth: 0, borderColor: color }} />
		</View>
	);
}

/** A clock with a turning arrow, for History (design board 4's header button): the circle is open at the top left,
 *  where the arrow turns back. */
export function Clock({ color }: { color: string }) {
	return (
		<View style={styles.icon20} aria-hidden>
			<View style={{ position: 'absolute', left: 1, top: 1, width: 18, height: 18, borderRadius: 9, borderWidth: 1.7, borderColor: color, borderLeftColor: 'transparent', transform: [{ rotate: '35deg' }] }} />
			<View style={{ position: 'absolute', left: 0.4, top: 3.2, width: 5, height: 5, borderLeftWidth: 1.7, borderBottomWidth: 1.7, borderColor: color, transform: [{ rotate: '-20deg' }] }} />
			<View style={{ position: 'absolute', left: 9.2, top: 5, width: 1.7, height: 5.6, backgroundColor: color, borderRadius: 1 }} />
			<View style={{ position: 'absolute', left: 9.6, top: 9.4, width: 1.7, height: 4.4, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '-55deg' }] }} />
		</View>
	);
}

/** A padlock: a change that can't be undone (design board 5). */
export function Lock({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 5, top: 1, width: 8, height: 9, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderWidth: 1.6, borderBottomWidth: 0, borderColor: color }} />
			<View style={{ position: 'absolute', left: 2.5, top: 8, width: 13, height: 9, borderRadius: 2, borderWidth: 1.6, borderColor: color }} />
		</View>
	);
}

/** A turning-back arrow: a change that was undone (design board 5). */
export function Undone({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 4, top: 5, width: 12, height: 11, borderTopRightRadius: 6, borderBottomRightRadius: 6, borderWidth: 1.6, borderLeftWidth: 0, borderColor: color }} />
			<View style={{ position: 'absolute', left: 2, top: 2.5, width: 6, height: 6, borderLeftWidth: 1.6, borderBottomWidth: 1.6, borderColor: color, transform: [{ rotate: '45deg' }] }} />
		</View>
	);
}

/** Fixed thread kinds use the same small line drawings as pinned views. */
export function ThreadKindIcon({kind,color}:{kind:'task'|'booking'|'stock'|'record'|'topic'|'private';color:string}) {
 if(kind==='booking')return <Calendar color={color}/>;
 return <View aria-hidden style={styles.icon18}>
  {kind==='task'?<><View style={{position:'absolute',left:3,top:1,width:12,height:16,borderRadius:3,borderWidth:1.5,borderColor:color}}/><View style={{position:'absolute',left:6,top:6,width:6,height:4,borderLeftWidth:1.5,borderBottomWidth:1.5,borderColor:color,transform:[{rotate:'-45deg'}]}}/></>:null}
  {kind==='stock'||kind==='record'?<><View style={{position:'absolute',left:2,top:3,width:14,height:13,borderWidth:1.5,borderColor:color,borderRadius:2}}/><View style={{position:'absolute',left:2,top:7,width:14,height:1.5,backgroundColor:color}}/><View style={{position:'absolute',left:8,top:3,width:1.5,height:13,backgroundColor:color}}/></>:null}
  {kind==='private'?<><View style={{position:'absolute',left:5,top:1,width:8,height:10,borderRadius:5,borderWidth:1.5,borderColor:color}}/><View style={{position:'absolute',left:3,top:8,width:12,height:9,borderWidth:1.5,borderColor:color,borderRadius:2}}/></>:null}
  {kind==='topic'?<><View style={{position:'absolute',left:1,top:2,width:16,height:12,borderWidth:1.5,borderColor:color,borderRadius:4}}/><View style={{position:'absolute',left:4,top:12,width:4,height:4,borderLeftWidth:1.5,borderColor:color,transform:[{rotate:'35deg'}]}}/></>:null}
 </View>;
}

const styles = StyleSheet.create({
	chevron: { width: 10, height: 10, borderLeftWidth: 2.2, borderBottomWidth: 2.2, transform: [{ rotate: '45deg' }], marginLeft: 5, marginRight: 3 },
	chevronSmall: { width: 8, height: 8, borderLeftWidth: 1.8, borderBottomWidth: 1.8, marginLeft: 4, marginRight: 2 },
	chevronRight: { width: 9, height: 9, borderRightWidth: 2, borderTopWidth: 2, transform: [{ rotate: '45deg' }], marginRight: 4 },
	icon14: { width: 14, height: 14 },
	icon18: { width: 18, height: 18 },
	icon20: { width: 20, height: 20 }
});
