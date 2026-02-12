.PHONY: install build test lint format clean

install:
	npm install

build:
	npm run build

test:
	npm test

lint:
	npm run lint

format:
	npm run format

clean:
	rm -rf node_modules dist .next .turbo
