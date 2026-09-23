// Shared illustrative summaries, never live inference or a duplicate conversation.
const discussionPreviews={
  packaging:{title:'Packaging slot',summary:'Morning slot clashes with Pale ale. An afternoon slot after cleaning is proposed; no new booking is confirmed.',through:'22 Sep · 09:36'},
  artwork:{title:'Artwork for samples',summary:'Version 3 needs review, including the small text. Hold the sample pack until a version is marked ready.',through:'22 Sep · 09:36'},
  general:{title:'General',summary:'Material counts are ready for review. No decision has been recorded in this sample.',through:'21 Sep · 16:20'}
};
function discussionPreview(key,{icon,link},compact=false){
  const d=discussionPreviews[key];
  return `<a class="discussion-preview${compact?' compact':''}" href="${link('conversation')}&thread=${key}"><span class="summary-heading">${icon('chat')}<strong>${d.title}</strong>${icon('chevron')}</span><p>${d.summary}</p><small>Summary · Through ${d.through}</small></a>`;
}
