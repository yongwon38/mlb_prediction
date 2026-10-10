"""
3단계 구위 모델 인터페이스 — 웹 export·SHAP 캐시가 모델 종류와 무관하게 쓰는 약속

웹의 '구위 산출 근거'는 모델에 다음만 요구한다.
    predict(X)            -> (n,) 3단계 예측 (타구질, 낮을수록 좋은 구위)
    categories            -> STUFF_CAT_FEATURES 별 범주 목록 (학습 때 범주 순서)
    explain(X, exact)     -> (contrib (n, 피처 수), base)  :  base + contrib.sum(1) == predict(X)
                             exact=True  : 정확한 기여 (compute_shap.py 가 캐시로 저장)
                             exact=False : 빠른 근사 (캐시가 없을 때 export 가 사용)
    method(exact)         -> 'shap' | 'saabas' (웹 '읽는 법'에 표시)

현재 LightGBM 은 저장된 joblib 을 그대로 두고 불러올 때 LGBMStuffModel 로 감싼다 (모델 파일 해시 = SHAP 캐시 id 유지).
커스텀 모델(예 : HOF-Net)은 위 메서드를 갖춘 객체를 같은 파일로 저장하면 load_model 이 감싸지 않고 그대로 쓴다.
"""
import os

import joblib
import numpy as np

MODEL_FILE = 'stage3_stuff_lgbm.joblib'


def saabas_contrib(booster, X):
    """Saabas(경로 기반) 기여 : 트리마다 루트 -> 리프 경로에서 분기 변수에 노드값 변화를 귀속.
    리프별 기여 벡터를 미리 만들어 두고 pred_leaf 로 조회 -> 수 분 안에 전체 시즌 계산. bias + 합 = 예측 (정확)"""
    F = X.shape[1]
    trees = booster.dump_model()['tree_info']
    table = np.zeros((len(trees), max(t['num_leaves'] for t in trees), F))
    bias = 0.0
    for ti, tr in enumerate(trees):
        root = tr['tree_structure']
        if 'leaf_value' in root:
            bias += root['leaf_value']
            continue
        bias += root['internal_value']
        stack = [(root, np.zeros(F))]
        while stack:
            node, acc = stack.pop()
            for ch in (node['left_child'], node['right_child']):
                val = ch['leaf_value'] if 'leaf_index' in ch else ch['internal_value']
                a = acc.copy()
                a[node['split_feature']] += val - node['internal_value']
                if 'leaf_index' in ch:
                    table[ti, ch['leaf_index']] = a
                else:
                    stack.append((ch, a))
    leaves = booster.predict(X, pred_leaf=True)
    contrib = np.zeros((len(X), F))
    for ti in range(len(trees)):
        contrib += table[ti, leaves[:, ti]]
    return contrib, bias


class LGBMStuffModel:
    """LGBMRegressor 어댑터 : 정확한 기여 = TreeSHAP, 근사 = Saabas"""

    def __init__(self, model):
        self.model = model

    def predict(self, X):
        return self.model.predict(X)

    @property
    def categories(self):
        return self.model.booster_.pandas_categorical

    def explain(self, X, exact=True):
        if exact:
            c = self.model.booster_.predict(X, pred_contrib=True, num_threads=os.cpu_count())
            return c[:, :-1], float(c[0, -1])
        return saabas_contrib(self.model.booster_, X)

    def method(self, exact=True):
        return 'shap' if exact else 'saabas'


def _is_stuff_model(m):
    return all(hasattr(m, a) for a in ('predict', 'explain', 'categories', 'method'))


def load_model(model_dir):
    """모델 폴더의 3단계 모델 -> 인터페이스를 갖춘 객체"""
    m = joblib.load(os.path.join(model_dir, MODEL_FILE))
    return m if _is_stuff_model(m) else LGBMStuffModel(m)


def model_files(model_dir):
    """모델 식별용 파일 (ops.model_id = 이 파일들 해시 -> SHAP 캐시 경로)"""
    return [os.path.join(model_dir, MODEL_FILE)]
