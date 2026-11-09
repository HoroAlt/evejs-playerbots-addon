"use strict";

const JITA_SOLAR_SYSTEM_ID = 30000142;

function isPlayerbotActor(session) {
  return Boolean(session && session._playerBotActor === true &&
    session.sessionType === "playerbot-actor");
}

function isPlayerbotSelfTrade(session, buyerCharacterID, sellerCharacterID, buyerOwner, sellerOwner) {
  if (!isPlayerbotActor(session)) return false;
  const buyerID = Math.trunc(Number(buyerCharacterID) || 0);
  const sellerID = Math.trunc(Number(sellerCharacterID) || 0);
  if (buyerID > 0 && buyerID === sellerID) return true;
  const buyerWalletID = Math.trunc(Number(buyerOwner && buyerOwner.id) || 0);
  const sellerWalletID = Math.trunc(Number(sellerOwner && sellerOwner.id) || 0);
  return Boolean(buyerOwner && buyerOwner.isCorp && sellerOwner && sellerOwner.isCorp &&
    buyerWalletID > 0 && buyerWalletID === sellerWalletID);
}

// Jita is a seed source for bot purchases only. The market authority can
// match regional bids at their home station while the seller is elsewhere.
function isPlayerbotJitaSale(session, solarSystemID) {
  return isPlayerbotActor(session) && Number(solarSystemID) === JITA_SOLAR_SYSTEM_ID;
}

module.exports = {
  JITA_SOLAR_SYSTEM_ID,
  isPlayerbotActor,
  isPlayerbotSelfTrade,
  isPlayerbotJitaSale,
};
