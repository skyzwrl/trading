/// <reference types="@rbxts/testez/globals" />

import { createHarness, lastEvent, readyBoth, reasonOf, startTrade } from "./support";

export = () => {
	describe("items", () => {
		it("adds owned items and locks them", () => {
			const harness = createHarness();
			const { service } = harness;
			harness.inventory.give("alice", ["sword", "shield"]);
			startTrade(harness);

			expect(service.addItem("alice", "sword").ok).to.equal(true);
			expect(service.addItem("alice", "shield").ok).to.equal(true);

			const offer = service.getTrade("alice")!.offers[0];
			expect(offer.items.join(",")).to.equal("sword,shield");
			expect(service.isLocked("sword")).to.equal(true);
			expect(service.isLocked("shield")).to.equal(true);
		});

		it("rejects items the player doesn't own or already offered", () => {
			const harness = createHarness();
			harness.inventory.give("alice", ["sword"]);
			harness.inventory.give("bob", ["bow"]);
			startTrade(harness);

			expect(reasonOf(harness.service.addItem("alice", "bow"))).to.equal("NotOwned");
			harness.service.addItem("alice", "sword");
			expect(reasonOf(harness.service.addItem("alice", "sword"))).to.equal("AlreadyOffered");
		});

		it("won't let one item sit in two trades at once", () => {
			const harness = createHarness({ requestCooldown: 0 });
			const { service, inventory } = harness;
			inventory.give("alice", ["sword"]);
			startTrade(harness, "alice", "bob");
			startTrade(harness, "carol", "dave");
			service.addItem("alice", "sword");

			// carol's data claims the same sword, the lock is what stops it being traded away twice
			inventory.owners.set("sword", "carol");
			expect(reasonOf(service.addItem("carol", "sword"))).to.equal("ItemLocked");
		});

		it("caps the number of items in one offer", () => {
			const harness = createHarness({ maxItems: 2 });
			harness.inventory.give("alice", ["a", "b", "c"]);
			startTrade(harness);

			harness.service.addItem("alice", "a");
			harness.service.addItem("alice", "b");
			expect(reasonOf(harness.service.addItem("alice", "c"))).to.equal("OfferFull");
		});

		it("removes items and releases their locks", () => {
			const harness = createHarness();
			const { service } = harness;
			harness.inventory.give("alice", ["sword"]);
			startTrade(harness);
			service.addItem("alice", "sword");

			expect(service.removeItem("alice", "sword").ok).to.equal(true);
			expect(service.isLocked("sword")).to.equal(false);
			expect(service.getTrade("alice")!.offers[0].items.size()).to.equal(0);
			expect(reasonOf(service.removeItem("alice", "sword"))).to.equal("NotOffered");
		});
	});

	describe("currency", () => {
		it("validates currency against the player's balance", () => {
			const harness = createHarness();
			const { service } = harness;
			harness.inventory.balances.set("alice", 100);
			startTrade(harness);

			expect(reasonOf(service.setCurrency("alice", -5))).to.equal("InvalidAmount");
			expect(reasonOf(service.setCurrency("alice", 2.5))).to.equal("InvalidAmount");
			expect(reasonOf(service.setCurrency("alice", 0 / 0))).to.equal("InvalidAmount");
			expect(reasonOf(service.setCurrency("alice", math.huge))).to.equal("InvalidAmount");
			expect(reasonOf(service.setCurrency("alice", 101))).to.equal("NotEnoughCurrency");

			expect(service.setCurrency("alice", 100).ok).to.equal(true);
			expect(service.getTrade("alice")!.offers[0].currency).to.equal(100);
		});
	});

	describe("readying up", () => {
		it("clears both ready flags and the countdown whenever an offer changes", () => {
			const harness = createHarness();
			const { service } = harness;
			harness.inventory.give("alice", ["sword"]);
			harness.inventory.give("bob", ["bow", "arrow"]);
			startTrade(harness);
			service.addItem("alice", "sword");
			service.addItem("bob", "bow");
			readyBoth(harness);

			const counting = service.getTrade("alice")!;
			expect(counting.countdownEndsAt).to.be.ok();

			service.addItem("bob", "arrow");
			const changed = service.getTrade("alice")!;
			expect(changed.offers[0].ready).to.equal(false);
			expect(changed.offers[1].ready).to.equal(false);
			expect(changed.countdownEndsAt).never.to.be.ok();
			expect(changed.revision).to.equal(counting.revision + 1);
		});

		it("makes players wait a moment after a change before readying", () => {
			const harness = createHarness({ readyDelay: 3 });
			const { service } = harness;
			harness.inventory.give("alice", ["sword"]);
			startTrade(harness);
			service.addItem("alice", "sword");

			harness.advance(2.9);
			expect(reasonOf(service.setReady("bob", true))).to.equal("TooSoon");
			harness.advance(0.1);
			expect(service.setReady("bob", true).ok).to.equal(true);
		});

		it("rejects a ready for a deal the player didn't see", () => {
			const harness = createHarness();
			const { service } = harness;
			harness.inventory.give("alice", ["sword", "dagger"]);
			startTrade(harness);
			service.addItem("alice", "sword");
			const seen = service.getTrade("bob")!.revision;

			service.removeItem("alice", "sword");
			service.addItem("alice", "dagger");
			harness.advance(2);

			expect(reasonOf(service.setReady("bob", true, seen))).to.equal("Stale");
			expect(service.setReady("bob", true, service.getTrade("bob")!.revision).ok).to.equal(true);
		});

		it("won't ready a trade where nobody offers anything", () => {
			const harness = createHarness();
			startTrade(harness);
			harness.advance(2);

			expect(reasonOf(harness.service.setReady("alice", true))).to.equal("EmptyTrade");
		});
	});

	describe("leaving", () => {
		it("rejects offer actions from players who aren't trading", () => {
			const harness = createHarness();
			harness.inventory.give("alice", ["sword"]);
			const { service } = harness;

			expect(reasonOf(service.addItem("alice", "sword"))).to.equal("NotTrading");
			expect(reasonOf(service.setCurrency("alice", 1))).to.equal("NotTrading");
			expect(reasonOf(service.setReady("alice", true))).to.equal("NotTrading");
			expect(reasonOf(service.cancel("alice"))).to.equal("NotTrading");
		});

		it("cancels and unlocks when a player backs out", () => {
			const harness = createHarness();
			const { service, events } = harness;
			harness.inventory.give("alice", ["sword"]);
			startTrade(harness);
			service.addItem("alice", "sword");

			expect(service.cancel("bob").ok).to.equal(true);
			expect(lastEvent(events, "ended")!.reason).to.equal("Cancelled");
			expect(service.isTrading("alice")).to.equal(false);
			expect(service.isLocked("sword")).to.equal(false);
		});
	});
};
