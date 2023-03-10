// noinspection JSUnusedGlobalSymbols

import {
  CheckpointToken,
  Claimed,
  RevisionIncreased, VeDistributorAbi
} from "./types/templates/VeDistributorTemplate/VeDistributorAbi";
import {Upgraded} from "./types/ControllerData/VeDistributorAbi";
import {
  ControllerEntity,
  VeDistEntity, VeTetuEntity,
  VeUserEntity,
  VeUserVeDistRewardHistory
} from "./types/schema";
import {calculateApr, formatUnits, generateVeUserId, parseUnits} from "./helpers";
import {Address, BigDecimal, BigInt, log} from "@graphprotocol/graph-ts";
import {VaultAbi} from "./types/ControllerData/VaultAbi";
import {getUSDC, WEEK} from "./constants";
import {LiquidatorAbi} from "./types/templates/VeDistributorTemplate/LiquidatorAbi";

// ***************************************************
//                    MAIN LOGIC
// ***************************************************

export function handleCheckpointToken(event: CheckpointToken): void {
  const veDist = getVeDist(event.address.toHexString());
  const controller = ControllerEntity.load(veDist.controller) as ControllerEntity;
  const decimals = BigInt.fromI32(veDist.decimals);
  const rewardPrice = tryGetUsdPrice(controller.liquidator, veDist.rewardToken, decimals);
  updateVeDist(veDist, rewardPrice);
}

export function handleClaimed(event: Claimed): void {
  const veDist = getVeDist(event.address.toHexString());

  const decimals = BigInt.fromI32(veDist.decimals);
  const controller = ControllerEntity.load(veDist.controller) as ControllerEntity;
  const veUser = VeUserEntity.load(generateVeUserId(event.params.tokenId.toString(), veDist.ve)) as VeUserEntity;
  const claimed = formatUnits(event.params.amount, decimals);
  const rewardPrice = tryGetUsdPrice(controller.liquidator, veDist.rewardToken, decimals);
  const claimedUSD = claimed.times(rewardPrice);
  veUser.veDistRewardsTotal = veUser.veDistRewardsTotal.plus(claimed);
  veUser.veDistLastApr = calculateApr(BigInt.fromI32(veUser.veDistLastClaim), event.block.timestamp, claimedUSD, veUser.lockedAmountUSD);
  veUser.veDistLastClaim = event.block.timestamp.toI32();
  saveRewardHistory(veUser, event.block.timestamp, claimed, claimedUSD);
  veUser.save();


  updateVeDist(veDist, rewardPrice);
}

// ***************************************************
//                 ATTRIBUTES CHANGED
// ***************************************************

export function handleRevisionIncreased(event: RevisionIncreased): void {
  const veDist = getVeDist(event.address.toHexString());
  veDist.revision = event.params.value.toI32();
  veDist.save();
}

export function handleUpgraded(event: Upgraded): void {
  const veDist = getVeDist(event.address.toHexString());
  const implementations = veDist.implementations;
  implementations.push(event.params.implementation.toHexString())
  veDist.implementations = implementations;
  veDist.save()
}

// ***************************************************
//                     HELPERS
// ***************************************************

function getVeDist(veDistAdr: string): VeDistEntity {
  return VeDistEntity.load(veDistAdr) as VeDistEntity;
}

function updateVeDist(veDist: VeDistEntity, rewardPrice: BigDecimal): void {
  const veDistCtr = VeDistributorAbi.bind(Address.fromString(veDist.id));
  const tokenCtr = VaultAbi.bind(Address.fromString(veDist.rewardToken));

  const tokenDecimals = BigInt.fromI32(veDist.decimals);

  veDist.activePeriod = veDistCtr.activePeriod().toI32();
  veDist.timeCursor = veDistCtr.timeCursor().toI32();
  veDist.tokenLastBalance = formatUnits(veDistCtr.tokenLastBalance(), tokenDecimals);
  veDist.tokenBalance = formatUnits(tokenCtr.balanceOf(Address.fromString(veDist.id)), tokenDecimals);
  veDist.lastTokenTime = veDistCtr.lastTokenTime().toI32();

  const thisWeek = BigInt.fromI32(veDist.lastTokenTime).div(BigInt.fromString(WEEK.toString())).times(BigInt.fromString(WEEK.toString()));
  veDist.tokensPerWeek = formatUnits(veDistCtr.tokensPerWeek(thisWeek), tokenDecimals);

  const ve = VeTetuEntity.load(veDist.ve) as VeTetuEntity;
  veDist.apr = calculateApr(BigInt.fromI32(0), BigInt.fromString(WEEK.toString()), veDist.tokensPerWeek.times(rewardPrice), ve.lockedAmountUSD);

  veDist.save();
}

function saveRewardHistory(veUser: VeUserEntity, time: BigInt, claimed: BigDecimal, claimedUSD: BigDecimal): void {
  let history = VeUserVeDistRewardHistory.load(veUser.id + "_" + time.toString());
  if (!history) {
    history = new VeUserVeDistRewardHistory(veUser.id + "_" + time.toString());

    history.veUser = veUser.id;
    history.time = time.toI32();
    history.claimed = claimed;
    history.claimedUSD = claimedUSD;
    history.lockedAmountUSD = veUser.lockedAmountUSD;
    history.apr = veUser.veDistLastApr;

    history.save();
  }
}

function tryGetUsdPrice(
  liquidatorAdr: string,
  asset: string,
  decimals: BigInt
): BigDecimal {
  if (getUSDC().equals(Address.fromString(asset))) {
    return BigDecimal.fromString('1');
  }
  const liquidator = LiquidatorAbi.bind(Address.fromString(liquidatorAdr))
  const p = liquidator.try_getPrice(
    Address.fromString(asset),
    getUSDC(),
    parseUnits(BigDecimal.fromString('1'), decimals)
  );
  if (!p.reverted) {
    return formatUnits(p.value, decimals);
  }
  log.error("=== FAILED GET PRICE === liquidator: {} asset: {}", [liquidatorAdr, asset]);
  return BigDecimal.fromString('0')
}
