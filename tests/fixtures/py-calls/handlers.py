def helper(x):
    return x + 1


def handler(req):
    return helper(req)


class Service:
    def run(self):
        return self.compute()

    def compute(self):
        return 42
