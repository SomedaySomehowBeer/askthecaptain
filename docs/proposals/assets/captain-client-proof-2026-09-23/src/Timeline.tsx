import React, { useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { bookings, dateTime, dayLabel, range, resources, timezone } from './fixtures.ts';
import { DAY, HOUR, conflicts, geometry, scales, zoomOffset, type Booking, type Scale } from './model.ts';
import { Button, colours, styles } from './ui.tsx';
const laneWidth = 152;
const conflictIds = conflicts(bookings);
export function Timeline() {
  const [scale, setScale] = useState<Scale>('Days');
  const [offset, setOffset] = useState(0);
  const [height, setHeight] = useState(360);
  const [selected, setSelected] = useState<Booking | null>(null);
  const vertical = useRef<ScrollView>(null), horizontal = useRef<ScrollView>(null);
  const scrollY = useRef(0), scrollX = useRef(0);
  const viewport = useRef<View>(null);
  const pixels = scales[scale], total = (range.end - range.start) * pixels;
  const step = scale === 'Hours' ? HOUR : scale === 'Days' ? DAY : 7 * DAY;
  const first = Math.max(0, Math.floor(offset / pixels / step));
  const ticks = Array.from({ length: Math.ceil(height / pixels / step) + 2 }, (_, i) => first + i)
    .filter(i => i * step < range.end - range.start);
  const zoom = (next: Scale, anchor = height / 2) => {
    const y = zoomOffset(scrollY.current, anchor, pixels, scales[next], range.end - range.start, height);
    setScale(next); setOffset(y); scrollY.current = y;
    requestAnimationFrame(() => vertical.current?.scrollTo({ y, animated: false }));
  };
  const pinch = useRef({ distance: 0, anchor: 0, top: 0 });
  // Intentionally small JS-responder proof. Device tests determine whether native gesture work is needed.
  const responder = PanResponder.create({
    onStartShouldSetPanResponderCapture: event => event.nativeEvent.touches.length === 2,
    onMoveShouldSetPanResponderCapture: event => event.nativeEvent.touches.length === 2,
    onPanResponderGrant: event => {
      const [a, b] = event.nativeEvent.touches;
      if (!a || !b) return;
      pinch.current.distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
      pinch.current.anchor = Math.max(0, Math.min(height, (a.pageY + b.pageY) / 2 - pinch.current.top));
    },
    onPanResponderMove: event => {
      const [a, b] = event.nativeEvent.touches;
      if (!a || !b || pinch.current.distance <= 0) return;
      const ratio = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) / pinch.current.distance;
      const order: Scale[] = ['Weeks', 'Days', 'Hours'];
      const direction = ratio > 1.3 ? 1 : ratio < 0.77 ? -1 : 0;
      if (direction) {
        const next = order[Math.max(0, Math.min(2, order.indexOf(scale) + direction))]!;
        pinch.current.distance = 0; zoom(next, pinch.current.anchor);
      }
    },
    onPanResponderRelease: () => { pinch.current.distance = 0; },
    onPanResponderTerminate: () => { pinch.current.distance = 0; },
  });
  const inspectConflict = () => {
    const item = bookings.find(b => b.id === 'request')!;
    setSelected(item); setScale('Hours');
    const y = (item.start - range.start - HOUR) * scales.Hours;
    setOffset(y); scrollY.current = y;
    horizontal.current?.scrollTo({ x: 0, animated: false });
    requestAnimationFrame(() => vertical.current?.scrollTo({ y, animated: false }));
  };
  return <View style={styles.panel} testID="timeline-panel">
    <Text style={styles.title}>Equipment schedule</Text>
    <Text style={styles.small}>{dayLabel(range.start)}–{dayLabel(range.end - 1)} · {timezone}</Text>
    <View style={styles.row}>
      {(Object.keys(scales) as Scale[]).map(name => <Button key={name} label={name} selected={name === scale} onPress={() => zoom(name)} />)}
      <Button label="Inspect conflict" onPress={inspectConflict} />
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Button label="← Equipment" onPress={() => horizontal.current?.scrollTo({ x: Math.max(0, scrollX.current - laneWidth), animated: false })} />
      <Text style={styles.small}>{resources.length} resources</Text>
      <Button label="Equipment →" onPress={() => horizontal.current?.scrollTo({ x: scrollX.current + laneWidth, animated: false })} />
    </View>
    <View style={{ flex: 1, minHeight: 150, flexDirection: 'row', overflow: 'hidden', borderWidth: 1, borderColor: colours.line }}>
      <View style={{ width: 58, overflow: 'hidden' }}>
        <Text style={{ height: 36, fontSize: 10, paddingTop: 10, color: colours.ink }}>TIME</Text>
        <View style={{ flex: 1, overflow: 'hidden' }}>
          {ticks.map(i => <Text key={i} style={{ position: 'absolute', top: i * step * pixels - offset, fontSize: 10, color: colours.ink }}>
            {scale === 'Hours' ? dateTime(range.start + i * step).replace(', ', '\n') : dayLabel(range.start + i * step)}
          </Text>)}
        </View>
      </View>
      <ScrollView horizontal ref={horizontal} nestedScrollEnabled showsHorizontalScrollIndicator
        testID="equipment-scroll" onScroll={e => { scrollX.current = e.nativeEvent.contentOffset.x; }} scrollEventThrottle={16}>
        <View style={{ width: resources.length * laneWidth, flex: 1 }}>
          <View style={{ flexDirection: 'row', height: 36, backgroundColor: colours.pale }}>
            {resources.map(r => <Text key={r.id} style={{ width: laneWidth, padding: 9, fontSize: 11, color: colours.ink, fontWeight: '600' }}>{r.name}</Text>)}
          </View>
          <View ref={viewport} style={{ flex: 1 }} {...responder.panHandlers}
            onLayout={event => { setHeight(event.nativeEvent.layout.height); viewport.current?.measureInWindow((_x, y) => { pinch.current.top = y; }); }}>
            <ScrollView ref={vertical} nestedScrollEnabled testID="time-scroll"
              onScroll={e => { scrollY.current = e.nativeEvent.contentOffset.y; setOffset(scrollY.current); }} scrollEventThrottle={16}>
              <View style={{ height: total, width: resources.length * laneWidth }} testID="timeline-canvas">
                {ticks.map(i => <View key={`line-${i}`} style={{ position: 'absolute', top: i * step * pixels, height: 1, width: '100%', backgroundColor: colours.line }} />)}
                {resources.map((r, index) => <View key={r.id} style={{ position: 'absolute', left: index * laneWidth, width: laneWidth, height: total, borderRightWidth: 1, borderColor: colours.line }}>
                  {bookings.filter(b => b.resourceId === r.id).map(b => {
                    const shape = geometry(b, range, pixels);
                    if (!shape) return null;
                    const clash = conflictIds.has(b.id);
                    return <View key={b.id} style={{ position: 'absolute', top: shape.top, left: 4, right: 4, height: Math.max(2, shape.height), zIndex: clash ? 2 : 1 }}>
                      <Pressable accessibilityRole="button" onPress={() => setSelected(b)}
                        testID={`booking-${b.id}`} accessibilityLabel={`${b.title}; ${dateTime(b.start)} to ${dateTime(b.end)}${clash ? '; conflict, unconfirmed' : ''}`}
                        style={[local.booking, { height: '100%', borderColor: selected?.id === b.id ? colours.ink : 'transparent',
                          backgroundColor: b.kind === 'maintenance' ? '#ddd6c4' : clash ? '#e8c481' : '#cbdcbb' }]}>
                        <Text style={{ fontSize: 11, color: colours.ink }}>{shape.height >= 22 ? b.title : ''}</Text>
                      </Pressable>
                      {clash && <View style={{ position: 'absolute', right: 0, top: 0 }}><Button label="!" onPress={() => setSelected(b)} testID="conflict-marker" /></View>}
                    </View>;
                  })}
                </View>)}
              </View>
            </ScrollView>
          </View>
        </View>
      </ScrollView>
    </View>
    <View style={styles.row}><Button label="Next interval" onPress={() => setSelected(bookings[(bookings.findIndex(b => b.id === selected?.id) + 1) % bookings.length]!)} /><Text style={styles.small}>Inspect short bars without zooming</Text></View>
    <View style={{ minHeight: 62 }} accessibilityLiveRegion="polite" testID="booking-detail">
      {selected ? <><Text style={{ color: colours.ink, fontWeight: '600', fontSize: 12 }}>{selected.title}</Text>
        <Text style={styles.small}>{dateTime(selected.start)} → {dateTime(selected.end)}</Text>
        <Text style={styles.small}>{selected.kind === 'request' ? 'Unconfirmed request · conflict with an occupied interval' : 'Fictional occupied interval'} · no booking changes</Text></>
        : <Text style={styles.small}>Select an interval for exact times. Pinch or use Hours / Days / Weeks. Gaps describe only this fictional sample; dates outside it are not loaded.</Text>}
    </View>
  </View>;
}
const local = StyleSheet.create({ booking: { fontSize: 11, color: colours.ink, paddingHorizontal: 6, borderWidth: 2, overflow: 'hidden' } });
