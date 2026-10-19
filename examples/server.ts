import { Players, ReplicatedStorage } from "@rbxts/services";
import { bindTradeService, TradeInventory, TradeResult, TradeService, TradeView } from "@skyzwrl/trading";

interface Profile {
	readonly items: Map<string, string>;
	coins: number;
}

// whatever the game already uses for loaded player data
declare function getProfile(player: Player): Profile | undefined;
declare function saveProfile(player: Player): void;
declare function getItemValue(catalogId: string): number;

const MAX_ITEMS = 200;

const inventory: TradeInventory<Player> = {
	hasItem(player, itemId) {
		return getProfile(player)?.items.has(itemId) === true;
	},
	getCurrency(player) {
		return getProfile(player)?.coins ?? 0;
	},
	moveItem(from, to, itemId) {
		const source = getProfile(from);
		const target = getProfile(to);
		const catalogId = source?.items.get(itemId);
		if (source === undefined || target === undefined || catalogId === undefined) {
			return false;
		}
		source.items.delete(itemId);
		target.items.set(itemId, catalogId);
		return true;
	},
	moveCurrency(from, to, amount) {
		const source = getProfile(from);
		const target = getProfile(to);
		if (source === undefined || target === undefined || source.coins < amount) {
			return false;
		}
		source.coins -= amount;
		target.coins += amount;
		return true;
	},
	canReceive(player, incoming, outgoing) {
		const profile = getProfile(player);
		return profile !== undefined && profile.items.size() + incoming.size() - outgoing.size() <= MAX_ITEMS;
	},
};

export const trading = new TradeService<Player>({
	inventory,
	valueOf: (itemId, owner) => {
		const catalogId = getProfile(owner)?.items.get(itemId);
		return catalogId !== undefined ? getItemValue(catalogId) : 0;
	},
});
bindTradeService(trading);

const remote = new Instance("RemoteEvent");
remote.Name = "Trade";
remote.Parent = ReplicatedStorage;

function asPlayer(value: unknown): Player | undefined {
	return typeIs(value, "Instance") && value.IsA("Player") && value.Parent === Players ? value : undefined;
}

remote.OnServerEvent.Connect((player, action, value, revision) => {
	const other = asPlayer(value);
	let result: TradeResult | undefined;

	if (action === "request" && other) {
		result = trading.request(player, other);
	} else if (action === "accept" && other) {
		result = trading.accept(player, other);
	} else if (action === "decline" && other) {
		result = trading.decline(player, other);
	} else if (action === "add" && typeIs(value, "string")) {
		result = trading.addItem(player, value);
	} else if (action === "remove" && typeIs(value, "string")) {
		result = trading.removeItem(player, value);
	} else if (action === "currency" && typeIs(value, "number")) {
		result = trading.setCurrency(player, value);
	} else if (action === "ready" && typeIs(value, "boolean") && typeIs(revision, "number")) {
		result = trading.setReady(player, value, revision);
	} else if (action === "cancel") {
		result = trading.cancel(player);
	}

	if (result !== undefined && !result.ok) {
		remote.FireClient(player, "rejected", action, result.reason);
	}
});

function sendTrade(trade: TradeView<Player>, ...message: unknown[]) {
	for (const player of trade.players) {
		remote.FireClient(player, ...message);
	}
}

trading.onEvent((event) => {
	switch (event.kind) {
		case "requested":
			remote.FireClient(event.request.to, "requested", event.request.from, event.request.expiresAt);
			break;
		case "requestClosed":
			remote.FireClient(event.request.from, "requestClosed", event.request.to, event.reason);
			break;
		case "started":
		case "changed":
			sendTrade(event.trade, event.kind, event.trade);
			break;
		case "ended":
			sendTrade(event.trade, "ended", event.reason);
			if (event.record !== undefined) {
				// save both sides straight away so a server shutdown can't undo half of a trade
				for (const player of event.trade.players) {
					saveProfile(player);
				}
			}
			if (event.unreverted !== undefined && !event.unreverted.isEmpty()) {
				warn(`trade ${event.trade.id} could not undo ${event.unreverted.size()} transfers`);
			}
			break;
		case "imbalance":
			remote.FireClient(event.player, "imbalance", event.given, event.received);
			break;
	}
});

// anything else that removes items checks the lock first, so an offered item can't be spent mid trade
export function sellItem(player: Player, itemId: string): boolean {
	const profile = getProfile(player);
	const catalogId = profile?.items.get(itemId);
	if (profile === undefined || catalogId === undefined || trading.isLocked(itemId)) {
		return false;
	}
	profile.items.delete(itemId);
	profile.coins += math.floor(getItemValue(catalogId) * 0.5);
	return true;
}
