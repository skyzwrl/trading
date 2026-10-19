import { TradeInventory, Transfer } from "./types";

function move<P>(inventory: TradeInventory<P>, transfer: Transfer<P>, from: P, to: P): boolean {
	const [ok, moved] = pcall(() =>
		transfer.kind === "item"
			? inventory.moveItem(from, to, transfer.itemId)
			: inventory.moveCurrency(from, to, transfer.amount),
	);
	return ok && moved === true;
}

// all of the transfers happen or none of them do. what comes back is anything that moved but then
// couldn't be moved back, which is empty unless the data layer also fails during the rollback
export function transferAll<P>(
	inventory: TradeInventory<P>,
	transfers: readonly Transfer<P>[],
): { ok: boolean; unreverted: Transfer<P>[] } {
	for (let index = 0; index < transfers.size(); index++) {
		const transfer = transfers[index];
		if (move(inventory, transfer, transfer.from, transfer.to)) {
			continue;
		}

		const unreverted = new Array<Transfer<P>>();
		for (let done = index - 1; done >= 0; done--) {
			const reverse = transfers[done];
			if (!move(inventory, reverse, reverse.to, reverse.from)) {
				unreverted.push(reverse);
			}
		}
		return { ok: false, unreverted };
	}
	return { ok: true, unreverted: [] };
}
