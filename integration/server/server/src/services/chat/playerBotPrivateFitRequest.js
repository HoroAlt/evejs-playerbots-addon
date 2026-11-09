"use strict";

function getPrivatePlayerbotTargetCharacterID(descriptor, roomRecord, session) {
  if (!descriptor || descriptor.kind !== "private" || !roomRecord || !session) return 0;
  const match = /^private_(\d+)_(\d+)$/i.exec(String(descriptor.roomName || ""));
  if (!match) return 0;
  const firstID = Number(match[1]) || 0;
  const secondID = Number(match[2]) || 0;
  const senderID = Number(session.characterID || session.charid) || 0;
  if (!senderID || ![firstID, secondID].includes(senderID)) return 0;
  const allowed = Array.isArray(roomRecord.allowedParticipantCharacterIDs)
    ? roomRecord.allowedParticipantCharacterIDs.map(Number)
    : [];
  if (!allowed.includes(senderID) || !allowed.includes(firstID) || !allowed.includes(secondID)) return 0;
  return senderID === firstID ? secondID : firstID;
}

function extractSharedFittingID(message) {
  const text = String(message || "").trim();
  const link = text.match(/(?:fitting\s*id|fittingid|fitid|fitting)\s*(?::\/\/(?:\d+\/)?|[:=#]\s*|\s+)(\d+)/i);
  const numeric = text.match(/^(\d+)$/);
  const fittingID = Number(link && link[1] || numeric && numeric[1]) || 0;
  return Number.isSafeInteger(fittingID) && fittingID > 0 ? fittingID : 0;
}

module.exports = { getPrivatePlayerbotTargetCharacterID, extractSharedFittingID };
