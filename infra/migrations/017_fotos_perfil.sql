BEGIN;

CREATE TABLE public.fotos_perfil (
    firebase_uid TEXT PRIMARY KEY,

    imagem BYTEA NOT NULL,

    tipo_mime TEXT NOT NULL DEFAULT 'image/webp',

    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fotos_perfil_uid_check
        CHECK (firebase_uid ~ '^[A-Za-z0-9_-]{1,128}$'),

    CONSTRAINT fotos_perfil_mime_check
        CHECK (tipo_mime = 'image/webp'),

    CONSTRAINT fotos_perfil_tamanho_check
        CHECK (octet_length(imagem) BETWEEN 1 AND 1048576)
);

COMMIT;