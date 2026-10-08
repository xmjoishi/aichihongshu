import type {
  LocalProfileSummary,
  LocalItemSummary,
  LocalNoteSummary,
  LocalReferenceAccountSummary,
} from "../localTypes";

import type { Item, Note, Profile, ReferenceAccount } from "../types";

export function localItemToItem(item: LocalItemSummary): Item {
  return {
    id: item.id,
    title: item.title,
    image_path: item.imagePath,
    thumbnail_path: item.thumbnailPath,
    style: item.style,
    material: item.material,
    scene: item.scene,
    color: item.color,
    tags: item.tags,
    analysis_raw: item.analysisRaw,
    note_count: item.noteCount,
    created_at: item.createdAt,
    image_version: item.imageVersion,
    content_hash: item.contentHash,
    metadata_version: item.metadataVersion,
  };
}

export function localNoteToNote(note: LocalNoteSummary): Note {
  return {
    id: note.id,
    item_id: note.itemId,
    item_ids: note.itemIds,
    title: note.title,
    body: note.body,
    tags: note.tags,
    status: note.status as Note["status"],
    note_type: note.noteType as Note["note_type"],
    video_path: note.videoPath,
    likes: note.likes,
    comments: note.comments,
    collects: note.collects,
    published_at: note.publishedAt,
    note_url: note.noteUrl,
    account_ref: note.accountRef,
    cover_desc: note.coverDesc,
    prompt_used: note.promptUsed,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    content_version: note.contentVersion,
    deleted_at: note.deletedAt,
  };
}

export function localProfileToProfile(profile: LocalProfileSummary): Profile {
  return {
    id: profile.id,
    account_id: profile.accountId,
    display_name: profile.displayName,
    niche: profile.niche,
    target_audience: profile.targetAudience,
    content_pillars: profile.contentPillars,
    persona_name: profile.personaName,
    persona_bio: profile.personaBio,
    persona_tone: profile.personaTone,
    persona_taboos: profile.personaTaboos,
    followers: profile.followers,
    total_notes: profile.totalNotes,
    total_likes: profile.totalLikes,
    total_collects: profile.totalCollects,
    avg_likes: profile.avgLikes,
    avg_comments: profile.avgComments,
    avg_collects: profile.avgCollects,
    preferred_styles: profile.preferredStyles,
    preferred_scenes: profile.preferredScenes,
    hashtag_pool: profile.hashtagPool,
    posting_rhythm: profile.postingRhythm,
    avatar_url: profile.avatarUrl,
    xhs_bio: profile.xhsBio,
    xhs_follows: profile.xhsFollows,
    ip_location: profile.ipLocation,
    xhs_tags: profile.xhsTags,
    crawled_at: profile.crawledAt,
    updated_at: profile.updatedAt,
  };
}

export function localReferenceAccountToReferenceAccount(
  account: LocalReferenceAccountSummary,
): ReferenceAccount {
  return {
    id: account.id,
    account_id: account.accountId,
    name: account.name,
    followers: account.followers,
    total_likes: account.totalLikes,
    note_count: account.noteCount,
    avg_likes: account.avgLikes,
    avg_comments: account.avgComments,
    avg_collects: account.avgCollects,
    content_style: account.contentStyle,
    top_notes: account.topNotes,
    raw_data: account.rawData,
    crawled_at: account.crawledAt,
    analyzed_at: account.analyzedAt,
    insights: account.insights,
    insights_at: account.insightsAt,
  };
}
