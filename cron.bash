#!/bin/bash

DIR=$(dirname "$0")

env TZ='America/Sao_Paulo' node $DIR/index.js
