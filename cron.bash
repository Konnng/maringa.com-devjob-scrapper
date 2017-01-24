#!/bin/bash

DIR=$(dirname "$0")

source ~/.bashrc

env TZ='America/Sao_Paulo' node $DIR/index.js
