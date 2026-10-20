    function buildWorkerSource() {
        const deps = [
            'const AUTH_PARAM_KEYS = ' + JSON.stringify(AUTH_PARAM_KEYS) + ';',
            'const B2Y_TRIPLES = ' + JSON.stringify(B2Y_TRIPLES) + ';',
            'const XSHIFT = [' + XSHIFT.map(f => f.toString()).join(',') + '];',
            'const B2Y_SEED = 2463534242;',
            B2y.toString(),
            'B2y.b6o = ' + B2y.b6o + ';',
            'B2y.b6b = ' + B2y.b6b + ';',
            'B2y.b4v = ' + B2y.b4v + ';',
            v_mqg.toString(),
            v_6qg.toString(),
            v_7qg.toString(),
            v_9qg.toString(),
            v_qpg.toString(),
            a3f.toString(),
            A9p.toString(),
            workerMain.toString(),
            'workerMain();',
        ];
        return deps.join('\n');
    }

