.PHONY: up down logs seed test chaos fast clean
up:      ## start everything (same as: docker compose up --build)
	docker compose up --build -d
down:
	docker compose down
logs:
	docker compose logs -f api worker
seed:    ## idempotent demo data
	docker compose run --rm seed
test:    ## full scenario suite (T1-T10 + cancel/cache/audit); includes T4 which kills the worker container
	docker compose run --rm tools
chaos:   ## pretty runner for T1, T2, T4, T5
	docker compose run --rm tools node scripts/chaos.js
fast:    ## make mock providers fast & reliable for demos (latency 100-400ms, no random failures)
	curl -s -XPOST localhost:4000/chaos -H 'content-type: application/json' -d '{"provider":"*","latency_min_ms":100,"latency_max_ms":400,"error_rate":0,"rate_limit_rate":0,"hang_rate":0}'
clean:   ## remove containers AND the database volume
	docker compose down -v
