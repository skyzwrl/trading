import { Players, RunService } from "@rbxts/services";
import { TradeService } from "./service";

// keeps request expiry and countdowns moving and cleans up after players who leave
export function bindTradeService(service: TradeService<Player>): () => void {
	const heartbeat = RunService.Heartbeat.Connect(() => service.update());
	const leaving = Players.PlayerRemoving.Connect((player) => service.playerLeft(player));
	return () => {
		heartbeat.Disconnect();
		leaving.Disconnect();
	};
}
